import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master/profiles.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';
import type { Principal, Work } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const repository = 'owner/test-queue-release';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const loopId = 'graphyard-master-queue-operator';
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `queue-${principal.id}-${'x'.repeat(32)}` }));
const agentToken = `queue-agent-${randomUUID()}`;
let store: Store, http: ReturnType<typeof server>, url: string;

const call = async (bearer: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(parsed));
  return parsed;
};

const file = (title: string, extra: Record<string, unknown> = {}) => call(credentials[0].token, 'work', {
  why: 'Keep test queue bounded', simplest: 'Gate releaseBacklog on twice the available trial slots',
  title, type: 'chore', priority: 1,
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:release-follows-the-test-queue', 'e2e:fixture'] }],
  policy: { checks: ['test'], review: true }, ...extra,
}) as Promise<Work>;

const makeProfiles = (count: number): WorkerProfile[] => Array.from({ length: count }, (_, index) => ({
  name: `w${index + 1}`, principal: `worker-${index + 1}`, agentName: `agent-${index + 1}`,
  mode: 'launch', kind: 'claude', credentialFile: `/srv/w${index + 1}.token`, agentArgs: [], approvals: 'auto', environment: {},
}) as WorkerProfile);

const makeConfig = (workers: number) => masterConfigSchema.parse({
  version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/outside/bin/graphyard.mjs',
  repository, baseBranch: 'main', hostId: 'loop-host', masterAgentName: 'graphyard-master-queue',
  operatorAgent: { id: loopId, credentialFile: '/outside/operator-agent.token' },
  workers: makeProfiles(workers),
});

const queuedEntry = (index: number) => ({
  key: `GY-Q${index}`, id: randomUUID(), head: `${index}`.padStart(40, 'a'),
  submittedAt: '2026-11-22T00:00:00.000Z', waitingMs: 1000,
});

const withSlotsLimit = async <T>(limit: number, body: () => Promise<T>): Promise<T> => {
  const dir = await temporaryDirectory('heavy-jobs-limit');
  await writeFile(join(dir, 'limit'), `${limit}\n`);
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = dir;
  try { return await body(); }
  finally {
    if (previous === undefined) delete process.env[slotsDirectoryVariable];
    else process.env[slotsDirectoryVariable] = previous;
  }
};

before(async () => {
  store = await withDatabase('release-follows-the-test-queue');
  await store.init();
  http = server(new Engine(store, 300, repository), credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  await call(credentials[0].token, 'operator-agents', {
    id: loopId, displayName: 'Master loop', capabilities: [],
    scope: { repositories: [repository], workItems: ['*'] }, token: agentToken,
    reason: 'the loop releases under its own identity',
  });
});

after(async () => { http?.close(); await store?.close(); });

const runRelease = async (workers: number, state: ReturnType<typeof emptyDaemonState>) => {
  const config = makeConfig(workers);
  const released: string[] = [], reasons: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => Object.fromEntries(config.workers.map(w => [w.name, { available: true, reason: null }])),
    snapshot: async () => {
      const snapshot = await call(credentials[1].token, 'work-snapshot', undefined, { [coordinationViewHeader]: 'coordination' });
      return { work: snapshot.work as Work[], now: snapshot.now };
    },
    closeSession: () => {},
    release: async (item, reason) => {
      released.push(item.key);
      reasons.push(reason);
      return call(agentToken, `work/${item.id}/ready`, { expectedRevision: item.revision, reason });
    },
    dispatch: async () => ({ pane: null }),
    persist: async () => {},
  };
  await runCycle(config, state, effects);
  return { released, reasons };
};

test('unit:release-follows-the-test-queue 3 slots and 6 heads queued releases nothing; 5 queued releases one; yard repair releases at 10 queued', async () => {
  await withSlotsLimit(2, async () => {
    await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
    const a = await file('Backlog A', { priority: 1 });
    const b = await file('Backlog B', { priority: 1 });
    const repair = await file('Yard repair', { priority: 3, yardRepair: true });

    // Local heavy-job limit 2 + 1 ready remote host = 3 trial slots (limit 6); away host does not count.
    const hosts = [
      { host: 'local', local: true, away: false, cores: 8, celsius: 50, steal: 0, runs: 0 },
      { host: 'worker-host-1', away: false, cores: 8, celsius: 50, steal: 0, runs: 0 },
      { host: 'worker-host-2', away: true, reason: 'offline', cores: null, celsius: null, steal: null, runs: null },
    ];

    // 1) 3 slots (limit 6) and 6 heads queued -> ordinary backlog releases nothing (only yard repair would).
    // First test with only ordinary items queued: temporarily hold repair so we verify 6 queued releases nothing.
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{hold}', 'true'::jsonb) WHERE id = $1`, [repair.id]);
    const state6 = emptyDaemonState(makeConfig(24));
    state6.hosts = hosts;
    state6.mergeWriter.inFlights = [
      { ...queuedEntry(1), startedAt: '2026-11-22T00:00:00.000Z', step: 'trial', stepStartedAt: '2026-11-22T00:00:00.000Z' },
      { ...queuedEntry(2), startedAt: '2026-11-22T00:00:00.000Z', step: 'trial', stepStartedAt: '2026-11-22T00:00:00.000Z' },
    ];
    state6.mergeWriter.queue = [queuedEntry(3), queuedEntry(4), queuedEntry(5), queuedEntry(6)];
    const run6 = await runRelease(24, state6);
    assert.deepEqual(run6.released, [], '3 slots (limit 6) and 6 heads queued releases nothing');

    // 2) 3 slots (limit 6) and 5 heads queued -> releases exactly one ordinary item, naming the test-queue limit.
    const state5 = emptyDaemonState(makeConfig(24));
    state5.hosts = hosts;
    state5.mergeWriter.inFlights = [
      { ...queuedEntry(1), startedAt: '2026-11-22T00:00:00.000Z', step: 'trial', stepStartedAt: '2026-11-22T00:00:00.000Z' },
    ];
    state5.mergeWriter.queue = [queuedEntry(2), queuedEntry(3), queuedEntry(4), queuedEntry(5)];
    const run5 = await runRelease(24, state5);
    assert.deepEqual(run5.released, [a.key], '5 queued with limit 6 releases exactly one item');
    assert.match(run5.reasons[0]!, /test-queue limit/i, 'release reason names the test-queue limit');
    assert.match(run5.reasons[0]!, /5.*6/, 'release reason includes current count and limit');

    // 3) 3 slots (limit 6) and 10 heads queued -> yard repair still releases past both caps; ordinary item B waits.
    await store.pool.query(`UPDATE work_items SET document = document - 'hold' WHERE id = $1`, [repair.id]);
    const state10 = emptyDaemonState(makeConfig(24));
    state10.hosts = hosts;
    state10.mergeWriter.queue = Array.from({ length: 10 }, (_, i) => queuedEntry(i + 1));
    const run10 = await runRelease(24, state10);
    assert.deepEqual(run10.released, [repair.key], 'yard repair releases at 10 queued while ordinary backlog waits');
    assert.ok(!run10.released.includes(b.key), 'ordinary backlog stays unreleased at 10 queued');

    // 4) master status shows testQueue limit and current count.
    const root = await temporaryDirectory('master-status-test-queue');
    execFileSync('git', ['init', '-q', root]);
    const credDir = await temporaryDirectory('master-status-creds');
    const config = { ...makeConfig(24), credentialFile: join(credDir, 'coordinator.token') };
    await writeDaemonState(config, state5);
    const status = await masterStatusReport(root, config, async path => {
      if (path === 'work-snapshot') return call(credentials[1].token, 'work-snapshot');
      throw Object.assign(new Error('absent'), { status: 404 });
    }, async () => { throw new Error('no git'); });
    assert.deepEqual((status as any).testQueue, { count: 5, limit: 6, slots: 3 }, 'master status reports test-queue count, limit and slots');

    // 5) When worker concurrency is tighter than the test queue (2 in flight of 3 workers vs 0 of 6 queued), the release reason names worker-concurrency limit.
    const stateWorkerCap = emptyDaemonState(makeConfig(3));
    stateWorkerCap.hosts = hosts;
    const runWorkerCap = await runRelease(3, stateWorkerCap);
    assert.deepEqual(runWorkerCap.released, [b.key], 'releases B when worker concurrency has room and test queue is empty');
    assert.match(runWorkerCap.reasons[0]!, /worker-concurrency limit/i, 'release reason names the worker-concurrency limit when it is tighter');
  });
});

test('unit:release-follows-the-test-queue landsAlone waits for empty test/acceptance/merge and blocks other releases while in flight', async () => {
  await withSlotsLimit(2, async () => {
    await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
    const active = await file('Active in test');
    await call(credentials[0].token, `work/${active.id}/ready`, { expectedRevision: active.revision, reason: 'already released' });
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{stage}', '"test"'::jsonb) WHERE id = $1`, [active.id]);

    const alone = await file('Rename sweep', { priority: 0 });
    // Mark as landing alone through requirements revision.
    await call(credentials[0].token, `work/${alone.id}/requirements`, {
      expectedPolicyRevision: alone.policyRevision,
      reason: '1200-file sweep must land alone',
      criteria: alone.criteria,
      dependencies: alone.dependencies,
      exclusiveResources: [],
      landsAlone: true,
    });
    const ordinary = await file('Ordinary follow-up', { priority: 2 });

    // While `active` is in stage `test`, `alone` must not release even though it has priority 0; `ordinary` can release.
    const state1 = emptyDaemonState(makeConfig(24));
    const run1 = await runRelease(24, state1);
    assert.deepEqual(run1.released, [ordinary.key], 'landsAlone waits while another item is in test');

    // Finish both `active` and `ordinary`, add another ordinary item -> now `alone` releases, and while it is in flight nothing else releases.
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{stage}', '"done"'::jsonb) WHERE id IN ($1, $2)`, [active.id, ordinary.id]);
    const behind = await file('Behind alone', { priority: 1 });
    const state2 = emptyDaemonState(makeConfig(24));
    const run2 = await runRelease(24, state2);
    assert.deepEqual(run2.released, [alone.key], 'landsAlone releases once nothing else is in test, acceptance or merge, and blocks anything else in the same cycle');

    // On the next cycle, while `alone` is still in flight, `behind` must still wait.
    const run3 = await runRelease(24, state2);
    assert.deepEqual(run3.released, [], 'nothing else is released while landsAlone is in flight');
    assert.ok(behind.key);
  });
});
