import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { useTestStore } from './helpers/test-store.js';
import { Store } from '../src/store.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

// Every filed fixture owes an E2E proof and the serve declaration its trial needs.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3458: a Done item kept its ended attempt's implementation session running on a host that
// had left, so master status counted it as a worker (6/5 with five live). The loop closes the
// record of an ended attempt from the item's own state, wherever its session ran; a current
// leased attempt stays running.

const repository = 'owner/ended-old-host';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const workerA: Principal = { id: 'worker-a', role: 'worker', sessionKind: 'ai' };
const workerB: Principal = { id: 'worker-b', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, coordinator, workerA, workerB].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let store: Store, url: string;
const ok = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Graphyard-View': 'coordination' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as any;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
};
const claimed = async (worker: Principal, key: string, host: string) => {
  const filed = await ok(operator, 'POST', 'work', { why: 'w', simplest: 's', title: key, type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:ended-old-host-session', 'e2e:ended-old-host-session'] }] }) as Work;
  await ok(operator, 'POST', `work/${filed.id}/ready`, {});
  const work = await ok(worker, 'POST', `work/${filed.id}/claim`, {}) as Work;
  await ok(worker, 'POST', `work/${filed.id}/session`, { id: `${worker.id}:${work.epoch}`, kind: 'implementation', principal: worker.id, epoch: work.epoch, runtime: 'claude', host, pane: `pane-${key}`, subject: key, state: 'running' });
  return work;
};

useTestStore('ended-old-host-session', { leaseSeconds: 3_600, repository: repository, credentials: credentials }, ctx => { ({ store, url } = ctx); });

test('integration:ended-old-host-session — a Done item\'s session left running on a departed host is recorded finished with its reason, and master status counts only the live worker', async () => {
  // The Done item: its attempt ran on a host that has since left, and its record still says running.
  const done = await claimed(workerA, 'GY-81', 'departed-host');
  const closed = await ok(coordinator, 'POST', `work/${done.key}/close`, { kind: 'obsolete', reason: 'delivered by its successor' }) as Work;
  assert.equal(closed.stage, 'done');
  // Reaching Done now ends its sessions (GY-3388); an item that reached Done before that, or whose
  // superseded attempt ran elsewhere, still carries the running record, as GY-3317 did.
  const sessions = closed.sessions!.map(handle => handle.id === 'worker-a:1' ? { ...handle, state: 'running', endedAt: null, outcome: null } : handle);
  await store.pool.query('UPDATE work_items SET document = document || $2::jsonb WHERE id = $1', [closed.id, JSON.stringify({ sessions })]);
  // The current attempt: leased, running on this host.
  const live = await claimed(workerB, 'GY-82', 'loop-host');

  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'loop-host', masterAgentName: 'graphyard-master-old-host', workers: [],
  }) as MasterConfig;
  // This host's runtime lists only the live worker; the departed host answers nothing.
  const herdr = [{ name: 'worker-b', pane_id: 'pane-GY-82', agent_status: 'working', agent: 'claude' }];
  const closedPanes: string[] = [];
  const snapshot = async () => ok(coordinator, 'GET', 'work-snapshot') as Promise<{ work: Work[]; now: string }>;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: (await snapshot()).work, now: new Date().toISOString() }),
    agents: () => herdr as any, herdr: () => ({ agents: herdr as any[], available: true }),
    credentials: async () => ({}),
    dispatch: async () => { throw new Error('the fixture launches nothing'); },
    closeSession: pane => { closedPanes.push(pane); },
    recordSession: async (target, handle) => { await ok(coordinator, 'POST', `work/${target.id}/session`, handle); },
    persist: async () => {},
  };
  await runCycle(config, emptyDaemonState(config), effects, () => Date.now(), undefined, () => {});

  const work = (await snapshot()).work;
  const old = (await store.list()).find(item => item.id === done.id)!.sessions!.find(handle => handle.id === 'worker-a:1')!;
  assert.equal(old.state, 'finished', 'the ended attempt\'s session is recorded finished');
  assert.equal(old.outcome, `closed by the loop: ${done.key} is done (it ran on departed-host)`, 'the record names why it ended');
  assert.ok(!closedPanes.includes('pane-GY-81'), 'no pane on another host is closed from this one');
  const current = work.find(item => item.id === live.id)!;
  assert.equal(current.lease?.epoch, live.epoch, 'the current attempt keeps its lease');
  assert.equal(current.sessions!.find(handle => handle.id === `worker-b:${live.epoch}`)?.state, 'running', 'the current attempt\'s session stays running');

  const report = await masterStatusReport(await temporaryDirectory('ended-old-host-status'), config, path => ok(coordinator, 'GET', path), async () => { throw new Error('no git in the fixture'); });
  assert.deepEqual(report.sessions.map(session => session.work), [live.key], 'master status lists only the live worker');
  assert.match(report.workers, /^1\//, 'master status counts one worker');
});
