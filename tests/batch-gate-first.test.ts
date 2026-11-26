import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateLimitMs, gateRecordPath, gateSummary, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import { runCycle } from '../src/daemon/cycle.js';
import { mergeWriterIdle, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { batchGateFlights } from '../src/daemon/trial-slots.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { trialStartOrder, trialStartOwner } from '../src/merge-writer/trial-load.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3444: two batch gates in a row ran into their 45-minute bound on a loaded host, so nothing
// deployed — the fixes that relieve the load included. The gate now has first claim on trial slots,
// implementation can continue within resource limits, and a timed-out run starts
// again at once on main's newest tip.

const repository = 'owner/project';
const start = Date.parse('2030-04-01T00:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;

async function workerDuringGate(hold: 'heat' | 'pressure' | 'capacity' | null = null) {
  const world = await fixture(`worker-during-gate-${hold ?? 'free'}`);
  const tip = world.tip;
  const worker = { name: 'w1', principal: 'w1-principal', agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository, baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [worker], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
  const gates = (passed: string[]) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed.includes(name), reasons: passed.includes(name) ? [] : [`${name} refused`] }));
  const item = (fields: Record<string, unknown>) => ({
    description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1, createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000),
    ready: true, epoch: 0, lease: null, workspaces: [], submission: null, candidate: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, violations: [], sessions: [], gates: gates(['ready']), stage: 'ready', ...fields,
  }) as unknown as Work;
  const candidate = { sha: sha('head2'), baseSha: tip, pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' };
  const work = [
    item({ id: 'w1', key: 'GY-1', title: 'Repair known red on main', type: 'bug', priority: 0, releasedBy: 'master' }),
    item({ id: 'w2', key: 'GY-2', title: 'Queued merge', stage: 'build', epoch: 1, submission: { epoch: 1, pr: 2 }, candidate, gates: gates(['ready', 'build', 'review', 'test']),
      observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: iso(start) } }),
  ];
  if (hold === 'capacity') work.push(item({ id: 'busy', key: 'GY-3', title: 'Running worker', stage: 'build', epoch: 1, lease: { owner: worker.principal, epoch: 1, expiresAt: iso(start + 10 * minute) } }));
  let started!: () => void;
  const gateStarted = new Promise<void>(resolve => { started = resolve; });
  let settle!: () => void;
  const gateHold = new Promise<void>(resolve => { settle = resolve; });
  const seen = { dispatched: [] as string[], trials: 0, ticks: 0 };
  const ports: MergeWriterReads = {
    baseBranch: 'main', now: () => start, fetch: async () => tip, cores: 2, parallel: 1,
    git: async (args, extra) => execFileSync('git', ['-C', world.coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    gate: { root: world.coordinator, repository },
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async commit => { if (commit === tip) { started(); await gateHold; } else seen.trials += 1; return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }; },
    push: async () => 'pushed', holds: async () => false, record: async () => {},
  };
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(start) }),
    cpuPressure: async () => ({ pressure: hold === 'pressure' ? 'some avg60=90.00' : 'some avg60=0.00', stat: null, celsius: hold === 'heat' ? 96 : 60 }),
    agents: () => [], herdr: () => ({ agents: hold === 'capacity' ? [{ name: worker.agentName, agent_status: 'working' }] : [], available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: () => {},
    dispatch: async target => { seen.dispatched.push(target.key); return { pane: 'p1', epoch: 1 }; },
    // The dispatcher's tick launches the reviewer and producer sessions; a held launch would name its line.
    dispatchTick: async (_snapshot, held) => {
      if (hold === 'pressure') assert.match(held ?? '', /CPU pressure/, 'saturation holds reviews too');
      else assert.equal(held, undefined, 'reviews are not held by the gate');
      seen.ticks += 1;
    },
    mergeWriter: ports,
    persist: async () => {},
  };
  const state = emptyDaemonState(config);
  const flights = await batchGateStep({ state, effects, snapshot: { work, now: iso(start) }, now: () => start, log: () => {} });
  try {
    await Promise.race([gateStarted, flights!.gate!.then(() => { throw new Error('Gate ended before starting its checks'); })]);
    await runCycle(config, state, effects, () => start);
    await mergeWriterIdle(state);
    assert.ok(flights?.gate, 'the batch gate remains in flight');
    assert.equal(batchGateFlights.get(state)?.gate, flights.gate);
    const held = hold === 'pressure' || hold === 'capacity';
    assert.deepEqual(seen.dispatched, held ? [] : ['GY-1'],
      held ? `${hold} still holds implementation` : hold === 'heat' ? 'a hot sensor alone holds no launch (GY-3501), so the repair launches beside the gate' : 'the released repair is invited to claim while the gate runs');
    assert.equal(seen.trials, 0, 'the queued merge trial leaves the slot to the gate');
    assert.equal(seen.ticks, 1, 'reviews and producers still launch');
    const record = readGateRecord(gateRecordPath(world.coordinator))!;
    assert.equal(record.verified, world.verified, 'the in-flight tip is not yet verified');
    assert.match(gateSummary(record)!.inFlight!.holds, /implementation continues/);
    assert.equal(work[0]!.policy.review, true);
    assert.deepEqual(work[0]!.criteria[0]!.proofs, ['unit:item-works']);
    assert.ok(work[0]!.gates.filter(gate => ['build', 'review', 'test', 'merge'].includes(gate.name)).every(gate => !gate.passed), 'dispatch bypasses no delivery gate');
  } finally {
    settle();
    await flights?.gate;
  }
  assert.equal(readGateRecord(gateRecordPath(world.coordinator))!.verified, tip, 'the batch checks finish normally');
}

test('integration:worker-dispatch-during-batch-gate — a released repair launches beside the gate; a hot sensor holds no launch, while measured saturation and worker capacity still hold', async () => {
  await workerDuringGate();
  await workerDuringGate('heat');
  await workerDuringGate('pressure');
  await workerDuringGate('capacity');
});

test('e2e:worker-dispatch-during-batch-gate — a ready repair reaches a worker while real batch checks remain in flight and every delivery gate remains required', async () => {
  await workerDuringGate();
});

/** An origin whose main holds a verified base and one merge past it, the coordinator checkout, and a way to land another merge. */
async function fixture(label: string) {
  const base = await temporaryDirectory(label);
  const pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  const repo = await gitRepo({ root: pusher, label, files: { 'README.md': 'base\n', 'graphyard.json': '{}' }, origin: true }), origin = repo.origin, verified = repo.head;
  let n = 0;
  const land = async () => {
    n += 1;
    git(pusher, 'checkout', '-q', '-b', `item-${n}`);
    await mkdir(join(pusher, 'src'), { recursive: true });
    await writeFile(join(pusher, 'src', `f${n}.ts`), 'ok\n');
    git(pusher, 'add', '.');
    git(pusher, 'commit', '-q', '-m', `change ${n}`);
    git(pusher, 'checkout', '-q', 'main');
    git(pusher, 'merge', '-q', '--no-ff', '-m', `Merge GY-${n}: change ${n}`, `item-${n}`);
    git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    return git(pusher, 'rev-parse', 'HEAD');
  };
  const tip = await land();
  git(base, 'clone', '-q', origin, coordinator);
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeGateRecord(gateRecordPath(coordinator), { ...bootstrapGate(repository, verified), diagnosticsAt: iso(start) });
  return { coordinator, verified, tip, land };
}

/**
 * One loop over the fixture with every merge slot taken by a queued merge trial: the first gate trial
 * waits on `hold`, then lands another merge on main and overruns the gate's bound, so the run times out.
 */
async function gateFirstWorld(label: string) {
  const world = await fixture(label);
  let clock = start, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const gated: string[] = [];
  let newest: string | null = null;
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock, cores: 2, parallel: 1,
    fetch: async () => { git(world.coordinator, 'fetch', '-q', 'origin', 'main'); return git(world.coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', world.coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async commit => {
      gated.push(commit);
      if (gated.length === 1) { await hold; newest = await world.land(); clock += gateLimitMs + 1; }
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;
    },
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: world.coordinator, repository },
  };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
  // The one merge slot (two cores, parallel 1) is taken by a running merge trial.
  state.mergeWriter.inFlight = { key: 'GY-9', head: sha('queued'), startedAt: iso(start) } as any;
  const cycle = { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(start) } as any, performed: [], now: () => clock, log: () => {} };
  return { ...world, cycle, gated, release, newest: () => newest };
}

test('integration:batch-gate-first — the gate starts though every merge slot is taken, its trial containers start before queued merge trials, and a timed-out run starts again at once on main\'s newest tip', async () => {
  assert.ok(trialStartOrder.gate < trialStartOrder.merge, 'a freed trial container slot goes to the gate before a queued merge trial');
  assert.ok(trialStartOrder.gate < trialStartOrder.verification);
  const world = await gateFirstWorld('batch-gate-first-slots');
  const flights = await batchGateStep(world.cycle);
  assert.ok(flights?.gate, 'the gate starts with every merge slot taken');
  world.release();
  await flights!.gate;
  assert.equal(world.gated.length, 2, 'the timed-out run started again in the same flight, without waiting for a cycle or a slot');
  assert.equal(world.gated[0], world.tip);
  assert.equal(world.gated[1], world.newest(), 'the retry is cut from main\'s newest tip');
  const record = readGateRecord(gateRecordPath(world.coordinator))!;
  assert.equal(record.verified, world.newest(), 'the retry verified the newest tip, so it deploys');
  assert.equal(record.held, null);
});

test('e2e:batch-gate-first — with a gate in flight and merge trials queued, master status shows the gate holding first claim and implementation continuing; a forced timeout restarts the gate on the newest tip', async () => {
  const world = await gateFirstWorld('batch-gate-first-status');
  const flights = await batchGateStep(world.cycle);
  assert.ok(flights?.gate, 'the gate runs beside the queued merge trial');
  const deadline = Date.now() + 10_000;
  while (!readGateRecord(gateRecordPath(world.coordinator))?.inFlight && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const inFlight = gateSummary(readGateRecord(gateRecordPath(world.coordinator)))!.inFlight!;
  assert.equal(inFlight.tip, world.tip.slice(0, 12));
  assert.match(inFlight.holds, /first claim on trial slots/, 'master status shows the gate holding first claim');
  assert.match(inFlight.holds, /implementation continues/, 'and implementation can continue');
  world.release();
  await flights!.gate;
  const record = readGateRecord(gateRecordPath(world.coordinator))!;
  assert.deepEqual(world.gated, [world.tip, world.newest()], 'the forced timeout restarted the gate on the newest tip');
  assert.equal(record.verified, world.newest());
  assert.equal(gateSummary(record)!.inFlight, null, 'once settled the gate holds nothing');
});

test('integration:batch-gate-survives-restart — a loop restart during a gate run adopts the detached run instead of orphaning it, and neither the restart nor the wait of its own start counts against the bound', async () => {
  const { noteBatchGateStopping } = await import('../src/daemon/cycle-batch-gate.js');
  const world = await fixture('batch-gate-restart');
  let clock = start;
  const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;
  const launches: string[] = [], adoptions: string[] = [];
  let endFirst!: (error: Error) => void;
  const trialSlots = join(world.coordinator, '.graphyard', 'trial-slots');
  const loopReads = (adopt: MergeWriterReads['adoptTrialRun']): MergeWriterReads => ({
    baseBranch: 'main', now: () => clock, cores: 2, parallel: 1,
    fetch: async () => { git(world.coordinator, 'fetch', '-q', 'origin', 'main'); return git(world.coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', world.coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async () => { throw new Error('the gate trials detached'); },
    launchTrialRun: request => {
      launches.push(request.mergeSha);
      return { directory: '/runs/gate-1', mergeSha: request.mergeSha, trial: () => new Promise<MergeTrialRun>((_, reject) => { endFirst = reject; }), detach: () => {}, cancel: () => {} };
    },
    adoptTrialRun: adopt,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: world.coordinator, repository, slots: trialSlots },
  });
  const loop = (reads: MergeWriterReads) => {
    const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
    return { state, cycle: { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(start) } as any, performed: [], now: () => clock, log: () => {} } };
  };

  // The first loop launches the gate's check as a detached run, whose own container start then waits 30 minutes (GY-3474: its own wait, not the loop's heat hold on other launches).
  const first = loop(loopReads(async () => null));
  const firstFlight = await batchGateStep(first.cycle);
  const deadline = Date.now() + 10_000;
  while (!launches.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(launches, [world.tip], 'the check runs detached');
  await mkdir(trialSlots, { recursive: true });
  await writeFile(join(trialSlots, `wait-0-${process.pid}`), trialStartOwner(world.coordinator, world.tip));
  clock += 30 * minute;
  for (const until = Date.now() + 10_000; (readGateRecord(gateRecordPath(world.coordinator))!.inFlight?.waitedMs ?? 0) < 30 * minute && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 50));
  await rm(join(trialSlots, `wait-0-${process.pid}`));
  const kept = readGateRecord(gateRecordPath(world.coordinator))!.inFlight!;
  assert.equal(kept.run?.directory, '/runs/gate-1', 'the run\'s directory rides the record');
  assert.ok((kept.waitedMs ?? 0) >= 30 * minute, 'its own start\'s wait is not the gate\'s own time');
  assert.ok(kept.seenAt, 'the loop records when it last saw the run');

  // The loop restarts — a CLI upgrade — and is down for 20 minutes: 50 minutes have passed since the cut.
  noteBatchGateStopping(first.state);
  clock += 20 * minute;
  const second = loop(loopReads(async ref => { adoptions.push(ref.directory); return { directory: ref.directory, mergeSha: ref.mergeSha, trial: async () => passing, detach: () => {}, cancel: () => {} }; }));
  const secondFlight = await batchGateStep(second.cycle);
  await secondFlight!.gate;
  assert.deepEqual(adoptions, ['/runs/gate-1'], 'the next loop adopts the detached run');
  assert.deepEqual(launches, [world.tip], 'and launches no second run');
  const record = readGateRecord(gateRecordPath(world.coordinator))!;
  assert.equal(record.verified, world.tip, 'the adopted run\'s verdict verifies the tip: neither the restart nor the wait of its start timed it out');
  assert.equal(record.held, null);
  endFirst(new Error('the first loop stopped'));
  await firstFlight!.gate;
});

test('integration:batch-gate-survives-restart — a gate timeout that overlapped a restart or heat pause re-runs once on the newest main instead of holding', async () => {
  const world = await gateFirstWorld('batch-gate-restart-timeout');
  const flights = await batchGateStep(world.cycle);
  world.release();
  await flights!.gate;
  assert.deepEqual(world.gated, [world.tip, world.newest()], 'the timed-out run re-ran on the newest main');
  const record = readGateRecord(gateRecordPath(world.coordinator))!;
  assert.equal(record.held, null, 'a timeout never holds');
  assert.equal(record.verified, world.newest());
});
