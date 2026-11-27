import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTestStore } from './helpers/test-store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { controlPlaneRecordPath, writeControlPlaneRecord } from '../src/deploy-watch.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import type { Principal, Work } from '../src/model.js';
import { mainworksRepository } from '../src/scenarios.js';
import { api } from './helpers/api.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'loop-coordinator', role: 'coordinator' };
const operatorToken = `op-${'a'.repeat(40)}`;
const coordinatorToken = `co-${'b'.repeat(40)}`;
const credentials = [
  { ...operator, token: operatorToken },
  { ...coordinator, token: coordinatorToken },
];

const sha = (n: number) => String(n).padStart(40, 'c');

let url: string;
useTestStore('no-duplicate-repairs', { leaseSeconds: 7200, repository: mainworksRepository, credentials: credentials }, ctx => { ({ url } = ctx); });

const fetchSnapshot = async (): Promise<{ work: Work[]; now: string }> => {
  const response = await fetch(`${url}/api/work-snapshot`, { headers: { Authorization: `Bearer ${coordinatorToken}` } });
  assert.equal(response.status, 200);
  return await response.json() as { work: Work[]; now: string };
};

test('e2e:no-duplicate-repairs — a stub loop through a control-plane upgrade stuck for five cycles keeps one open repair item with its note count rising', async () => {
  const root = await temporaryDirectory('no-duplicate-repairs');
  const config = masterConfigSchema.parse({
    version: 1,
    url,
    credentialFile: '/outside/coordinator.token',
    cliPath: '/bin/graphyard',
    repository: mainworksRepository,
    baseBranch: 'main',
    hostId: 'machine-a',
    masterAgentName: 'graphyard-master-mainworks',
    workers: [],
  });

  const post = async (token: string, path: string, body: unknown, key: string) => {
    const result = await api(url, token, path, { body, key });
    if (result.status >= 300) throw new Error(`${path} refused (${result.status}): ${JSON.stringify(result.body).slice(0, 200)}`);
    return result.body;
  };

  const effects: DaemonEffects = {
    snapshot: fetchSnapshot,
    agents: () => [],
    herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => ({ pane: 'p1', epoch: 1 }),
    mergeWriter: {
      gate: { root, repository: mainworksRepository },
      createWork: (input: unknown, key: string) => post(operatorToken, 'work', input, key),
      note: (item: Pick<Work, 'id' | 'key'>, text: string, key: string) =>
        post(coordinatorToken, `work/${item.id}/request`, { type: 'note', reason: text }, key),
    } as unknown as MergeWriterReads,
    persist: async () => {},
  };

  const state = emptyDaemonState(config);
  let clock = Date.parse('2026-11-22T10:00:00Z');
  const noteCounts: number[] = [];

  for (let pass = 0; pass < 5; pass++) {
    await writeControlPlaneRecord(controlPlaneRecordPath(root), {
      commit: sha(1),
      verified: sha(10 + pass),
      verifiedSeenAt: new Date(clock).toISOString(),
      failedStep: 'restart',
      failedReason: `restart failed on cycle ${pass + 1}`,
      failedAt: new Date(clock).toISOString(),
    });
    await runCycle(config, state, effects, () => clock, undefined, () => {});
    const { work } = await fetchSnapshot();
    const openRepairs = work.filter(item => item.stage !== 'done' && item.title === 'Control-plane upgrade stuck at restart');
    assert.equal(openRepairs.length, 1, `cycle ${pass + 1}: exactly one open repair item`);
    assert.equal(openRepairs[0]!.faultKey, 'control-plane-upgrade:restart');
    const notes = (openRepairs[0]!.agentRequests ?? []).filter(request => request.type === 'note').length;
    noteCounts.push(notes);
    clock += 60_000;
  }

  assert.deepEqual(noteCounts, [0, 1, 2, 3, 4], 'note count rises on each repeat cycle');
});
