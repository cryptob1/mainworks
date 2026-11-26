import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master/profiles.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';
import type { Principal, Work } from '../src/model.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { listen } from './helpers/http-server.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const repository = 'owner/release-waits-queue';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const loopId = 'graphyard-master-e2e-queue';
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `e2eq-${principal.id}-${'x'.repeat(32)}` }));
const agentToken = `e2eq-agent-${randomUUID()}`;
let store: Store, close: (() => Promise<void>) | undefined, url: string;

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
  why: 'Keep test queue bounded', simplest: 'Release only while test queue has room',
  title, type: 'chore', priority: 1,
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:release-follows-the-test-queue', 'e2e:release-waits-for-the-test-queue'] }],
  policy: { checks: ['test'], review: true }, ...extra,
}) as Promise<Work>;

before(async () => {
  store = await withDatabase('release-waits-for-the-test-queue');
  await store.init();
  ({ url, close } = await listen(server(new Engine(store, 300, repository), credentials)));
  await call(credentials[0].token, 'operator-agents', {
    id: loopId, displayName: 'Master loop', capabilities: [],
    scope: { repositories: [repository], workItems: ['*'] }, token: agentToken,
    reason: 'the loop releases under its own identity',
  });
});

after(async () => { await close?.(); await store?.close(); });

test('e2e:release-waits-for-the-test-queue 8 backlog items, 24 allowed workers, 3 trial slots, 3-cycle stub trial: test queue never exceeds 6 and lands-alone item releases last', async () => {
  const slotsDir = await temporaryDirectory('e2e-heavy-jobs');
  await writeFile(join(slotsDir, 'limit'), '2\n'); // 2 local + 1 ready remote host = 3 trial slots
  const previousSlots = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = slotsDir;

  try {
    await store.pool.query('TRUNCATE work_items, events, receipts, jobs CASCADE');
    const items: Work[] = [];
    for (let i = 1; i <= 7; i++) items.push(await file(`Ordinary item ${i}`, { priority: 1 }));
    const landsAlone = await file('Lands alone sweep', { priority: 1 });
    await call(credentials[0].token, `work/${landsAlone.id}/requirements`, {
      expectedPolicyRevision: landsAlone.policyRevision,
      reason: 'large sweep must land alone',
      criteria: landsAlone.criteria,
      dependencies: landsAlone.dependencies,
      exclusiveResources: [],
      landsAlone: true,
    });
    items.push(landsAlone);

    const workers: WorkerProfile[] = Array.from({ length: 24 }, (_, i) => ({
      name: `w${i + 1}`, principal: `worker-${i + 1}`, agentName: `agent-${i + 1}`,
      mode: 'launch', kind: 'claude', credentialFile: `/srv/w${i + 1}.token`, agentArgs: [], approvals: 'auto', environment: {},
    }) as WorkerProfile);

    const config = masterConfigSchema.parse({
      version: 1, url, credentialFile: '/outside/coordinator.token', cliPath: '/outside/bin/graphyard.mjs',
      repository, baseBranch: 'main', hostId: 'loop-host', masterAgentName: 'graphyard-master-e2e-queue',
      operatorAgent: { id: loopId, credentialFile: '/outside/operator-agent.token' },
      workers,
    });

    const state = emptyDaemonState(config);
    state.hosts = [
      { host: 'local', local: true, away: false, cores: 8, celsius: 50, steal: 0, runs: 0 },
      { host: 'remote-1', away: false, cores: 8, celsius: 50, steal: 0, runs: 0 },
    ];

    const trialSlots = 3;
    const trialDurationCycles = 3;
    const releaseOrder: string[] = [];
    const maxQueueSeen: number[] = [];
    // Stub trial queue & active trials (each takes 3 cycles).
    const waitingQueue: { key: string; id: string; head: string }[] = [];
    const runningTrials: { key: string; id: string; head: string; remainingCycles: number }[] = [];

    const effects: DaemonEffects = {
      agents: () => [], herdr: () => ({ agents: [], available: true }),
      credentials: async () => Object.fromEntries(workers.map(w => [w.name, { available: true, reason: null }])),
      snapshot: async () => {
        const snapshot = await call(credentials[1].token, 'work-snapshot', undefined, { [coordinationViewHeader]: 'coordination' });
        return { work: snapshot.work as Work[], now: snapshot.now };
      },
      closeSession: () => {},
      release: async (item, reason) => {
        releaseOrder.push(item.key);
        return call(agentToken, `work/${item.id}/ready`, { expectedRevision: item.revision, reason });
      },
      dispatch: async item => {
        // Worker immediately builds and submits to the test queue.
        const head = item.key.replace(/\D/g, '').padStart(40, 'b');
        await store.pool.query(
          `UPDATE work_items SET document = jsonb_set(document, '{stage}', '"test"'::jsonb) WHERE id = $1`,
          [item.id],
        );
        if (!waitingQueue.some(q => q.id === item.id) && !runningTrials.some(t => t.id === item.id)) {
          waitingQueue.push({ key: item.key, id: item.id, head });
        }
        return { pane: null };
      },
      persist: async () => {},
    };

    const syncMergeWriterState = () => {
      const nowIso = new Date().toISOString();
      state.mergeWriter.inFlights = runningTrials.map(t => ({
        key: t.key, id: t.id, head: t.head, startedAt: nowIso, step: 'trial', stepStartedAt: nowIso,
      }));
      state.mergeWriter.inFlight = state.mergeWriter.inFlights[0] ?? null;
      state.mergeWriter.queue = waitingQueue.map(q => ({
        key: q.key, id: q.id, head: q.head, submittedAt: nowIso, waitingMs: 1000,
      }));
    };

    for (let cycle = 1; cycle <= 30; cycle++) {
      syncMergeWriterState();
      await runCycle(config, state, effects);

      // Start trials up to the 3 available trial slots from newly submitted/waiting heads.
      while (runningTrials.length < trialSlots && waitingQueue.length > 0) {
        const next = waitingQueue.shift()!;
        runningTrials.push({ ...next, remainingCycles: trialDurationCycles });
      }
      syncMergeWriterState();

      const totalQueued = runningTrials.length + waitingQueue.length;
      maxQueueSeen.push(totalQueued);
      assert.ok(totalQueued <= 6, `cycle ${cycle}: test queue reached ${totalQueued}, exceeding 6 (twice 3 trial slots)`);

      // Advance stub trials by 1 cycle; trials finishing after 3 cycles land as done.
      const stillRunning: typeof runningTrials = [];
      for (const trial of runningTrials) {
        trial.remainingCycles -= 1;
        if (trial.remainingCycles <= 0) {
          await store.pool.query(
            `UPDATE work_items SET document = jsonb_set(document, '{stage}', '"done"'::jsonb) WHERE id = $1`,
            [trial.id],
          );
        } else {
          stillRunning.push(trial);
        }
      }
      runningTrials.length = 0;
      runningTrials.push(...stillRunning);

      const snapshot = await call(credentials[1].token, 'work-snapshot');
      if ((snapshot.work as Work[]).every(w => w.stage === 'done')) break;
    }

    assert.equal(releaseOrder.length, 8, `all 8 items should be released, got ${releaseOrder.length}`);
    assert.equal(releaseOrder.at(-1), landsAlone.key, `lands-alone item ${landsAlone.key} must be released last; order was ${releaseOrder.join(', ')}`);
    assert.equal(Math.max(...maxQueueSeen), 6, 'the test queue should fill up to 6 and never exceed 6');
  } finally {
    if (previousSlots === undefined) delete process.env[slotsDirectoryVariable];
    else process.env[slotsDirectoryVariable] = previousSlots;
  }
});
