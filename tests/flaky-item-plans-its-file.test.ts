import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { useTestStore } from './helpers/test-store.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { gateFiledItem } from '../src/daemon/control-plane.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3810: a flaky-check or known-red item the loop files for test:F sets plannedFiles to [F],
// and dispatch does not launch it while another released item planning F is in build.

const repository = 'cryptob1/graphyard';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workers: Principal[] = ['a', 'b', 'c', 'd'].map(name => ({ id: `worker-${name}`, role: 'worker', sessionKind: 'ai' }));
const credentials = [operator, coordinator, ...workers].map(principal => ({ ...principal, token: `flaky-plan-${principal.id}-${'x'.repeat(32)}` }));
const token = (id: string) => credentials.find(credential => credential.id === id)!.token;
let store: Store, url: string;

const ok = async (bearer: string, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(parsed));
  return parsed;
};
const update = (id: string, patch: Record<string, unknown>) =>
  store.pool.query('UPDATE work_items SET document = document || $1::jsonb WHERE id = $2', [JSON.stringify(patch), id]);

const profile = (name: string, principal: string): WorkerProfile =>
  ({ name, principal, agentName: `agent-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/srv/credentials/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile);
const masterConfig = (): MasterConfig => masterConfigSchema.parse({
  version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/outside/bin/graphyard.mjs',
  repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-flaky-plan', autoMerge: true, mergeMethod: 'merge',
  workers: workers.map((worker, index) => profile(`p${index}`, worker.id)),
});

useTestStore('flaky-item-plans-its-file', { leaseSeconds: 300, repository: repository, credentials: credentials }, ctx => { ({ store, url } = ctx); });

test('integration:flaky-item-plans-its-file — loop-filed flaky/known-red test items set plannedFiles to [F] and wait until an in-build item planning F merges or leaves build', async () => {
  const testFile = 'tests/flow-overlap.test.ts';
  const flakyPayload = gateFiledItem({ key: `flake:test:${testFile}`, title: `Flaky check on main: test:${testFile}`, description: 'Flaked on main.' }, 'main', repository);
  const knownRedPayload = gateFiledItem({ key: `known-red:test:${testFile}`, title: `Known red on main: test:${testFile}`, description: 'Red on main.' }, 'main', repository);
  const e2ePayload = gateFiledItem({ key: 'flake:e2e:smoke', title: 'Flaky check on main: e2e:smoke', description: 'Flaked.' }, 'main', repository);

  assert.deepEqual((flakyPayload as { plannedFiles?: string[] }).plannedFiles, [testFile]);
  assert.deepEqual((knownRedPayload as { plannedFiles?: string[] }).plannedFiles, [testFile]);
  assert.equal((e2ePayload as { plannedFiles?: string[] }).plannedFiles, undefined);

  const other = await ok(token(operator.id), 'POST', 'work', {
    why: 'w', simplest: 's', title: 'Fix flow test', type: 'chore', priority: 1,
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:flaky-item-plans-its-file', 'e2e:fixture'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [testFile],
  }) as Work;
  await update(other.id, { ready: true });
  await ok(token(workers[0].id), 'POST', `work/${other.id}/claim`, {});

  const flaky = await ok(token(operator.id), 'POST', 'work', flakyPayload) as Work;
  const knownRed = await ok(token(operator.id), 'POST', 'work', knownRedPayload) as Work;
  assert.deepEqual(flaky.plannedFiles, [testFile]);
  assert.deepEqual(knownRed.plannedFiles, [testFile]);
  await update(flaky.id, { ready: true });
  await update(knownRed.id, { ready: true });

  const herdr = { agents: [{ name: 'agent-p0', pane_id: `pane-${other.key}`, agent: 'claude', agent_status: 'working' }] as HerdrAgent[] };
  const config = masterConfig();
  const claims: string[] = [];
  const effects: DaemonEffects = {
    agents: () => herdr.agents,
    herdr: () => ({ agents: herdr.agents, available: true }),
    credentials: async () => Object.fromEntries(config.workers.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => {
      const snapshot = await ok(token(coordinator.id), 'GET', 'work-snapshot', undefined, { [coordinationViewHeader]: 'coordination' });
      return { work: snapshot.work as Work[], now: snapshot.now };
    },
    closeSession: () => {},
    dispatch: async (item, chosen) => {
      const claimed = await ok(token(chosen.principal), 'POST', `work/${item.id}/claim`, {}) as Work;
      herdr.agents = [...herdr.agents, { name: chosen.agentName, pane_id: `pane-${item.key}`, agent: 'claude', agent_status: 'working' }];
      claims.push(item.key);
      return { pane: `pane-${item.key}`, epoch: claimed.epoch };
    },
    persist: async () => {},
  };
  const state: DaemonState = emptyDaemonState(config);

  // While `other` (planning testFile) is in build, neither flaky nor knownRed is launched.
  await runCycle(config, state, effects);
  assert.deepEqual(claims, [], 'neither flaky nor known-red launches while another item planning F is in build');

  // Once `other` merges (stage done), one of them launches, and the second waits while the first is in build.
  await update(other.id, { stage: 'done', lease: null });
  herdr.agents = [];
  await runCycle(config, state, effects);
  assert.equal(claims.length, 1, 'exactly one item planning F launches after the in-build item merges');

  // Once the first leaves build (moves to review), the second launches.
  const firstId = claims[0] === flaky.key ? flaky.id : knownRed.id;
  await update(firstId, { stage: 'review', lease: null });
  herdr.agents = [];
  await runCycle(config, state, effects);
  assert.equal(claims.length, 2, 'the second item launches once the first leaves build');
});

test('e2e:flaky-item-plans-its-file — on a running test install a filed flaky-check item shows its test file as planned', { timeout: 280_000 }, async () => {
  const flakyTest = `const { test } = require('node:test');
const fs = require('fs');
test('tests/flaky.test.cjs passes unless broken', () => {
  const marker = fs.existsSync('broken') ? fs.readFileSync('broken', 'utf8').trim() : '';
  if (marker && !fs.existsSync(marker)) { fs.writeFileSync(marker, ''); throw new Error('flaked'); }
});
`;
  const where = await pipelineWorld('flaky-item-plans-its-file-e2e', {
    'package.json': JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs tests/flaky.test.cjs' } }),
    'tests/flaky.test.cjs': flakyTest,
  });
  try {
    const loop = worldLoop(where, { gate: false, attribute: true });
    const change = await where.submit('A change the flaky test fails once on', { broken: `${join(where.root, 'flaked-once')}\n` });
    await cycleUntil(loop, `${change.key} merges`, async () => (await where.work()).find(item => item.id === change.id)?.stage === 'done');
    const filed = (await where.work()).find(item => item.title === 'Flaky check on main: test:tests/flaky.test.cjs');
    assert.ok(filed, 'the flaky-check item was filed on the running test install');
    assert.deepEqual(filed.plannedFiles, ['tests/flaky.test.cjs'], 'the filed flaky-check item shows its test file as planned');
  } finally {
    await where.close();
  }
});
