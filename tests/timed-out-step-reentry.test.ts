import './helpers/temp-dirs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCycle, standingStepFailures, stepTimeoutMs } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergePorts, MergeRecordEvent } from '../src/merge-writer/executor.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master/profiles.js';
import { trialRunsDirectory, stopTrialRun } from '../src/merge-writer/trial-run.js';
import { pipelineWorld } from './helpers/pipeline-world.js';
import { workFixture } from './helpers/work-fixture.js';

const start = Date.parse('2030-04-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('main-tip');
const worker = { name: 'w1', principal: 'w1-principal', agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const config = masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  workers: [worker], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } },
});
const gates = (passed: string[]) => ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: passed.includes(name), reasons: passed.includes(name) ? [] : [`${name} refused`] }));
const makeItem = (fields: Record<string, unknown>) => workFixture({
  priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start - 60_000), sessions: [], gates: gates(['ready']), ...fields,
});
const settle = async () => { for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve)); };

test('unit:timed-out-step-is-not-reentered — a merge step whose body takes three cycles is entered once, close and dispatch run in between, and status shows one line while it lasts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = start;
  let mergeEntries = 0, dispatches = 0, closes = 0;
  let releaseMerge!: () => void;
  const mergeBody = new Promise<null>(resolve => { releaseMerge = () => resolve(null); });
  let snapshotCount = 0;
  const doneItem = (n: number) => makeItem({
    id: `w3-${n}`, key: `GY-3${n}`, title: 'Delivered', stage: 'done', epoch: n,
    sessions: [{ id: `w1-principal:${n}`, kind: 'implementation', principal: 'w1-principal', epoch: n, runtime: 'claude', host: 'machine-a', workspace: null, tab: null, pane: `p${n}`, agentName: 'agent-w1', role: null, head: null, attach: null, transcript: null, subject: `GY-3${n}: Delivered`, startedAt: iso(start), updatedAt: iso(start), endedAt: null, state: 'running', outcome: null }],
  });
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock,
    fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }),
    push: async () => 'pushed',
    holds: async () => false,
    record: async () => {},
    memory: () => { mergeEntries += 1; return mergeEntries === 1 ? mergeBody : Promise.resolve(null); },
  };
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [doneItem(++snapshotCount)], now: iso(clock) }),
    agents: () => [], herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: () => { closes += 1; },
    dispatch: async () => {},
    dispatchTick: async () => { dispatches += 1; },
    mergeWriter: reads,
    persist: async () => {},
  };
  const state = emptyDaemonState(config);
  const lines: string[] = [];

  // Cycle 1: merge writer starts and outlives its step timeout.
  const c1 = runCycle(config, state, effects, () => clock, undefined, line => lines.push(line));
  await settle();
  assert.equal(mergeEntries, 1, 'merge step entered on cycle 1');
  t.mock.timers.tick(stepTimeoutMs(config));
  await c1;
  assert.equal(closes, 1, 'close ran on cycle 1');
  assert.equal(dispatches, 1, 'dispatch ran on cycle 1');
  const status1 = standingStepFailures(state);
  assert.equal(status1.length, 1, `status shows one line while merge writer is still running: ${JSON.stringify(status1)}`);
  assert.ok(status1[0]!.includes('merge writer') && status1[0]!.includes(iso(start)), status1[0]);

  // Cycle 2: merge writer is still running — skipped, while close and dispatch still run.
  clock += 30_000;
  const c2 = await runCycle(config, state, effects, () => clock, undefined, line => lines.push(line));
  assert.equal(mergeEntries, 1, 'merge step is NOT re-entered on cycle 2 while cycle 1 body is still running');
  assert.equal(closes, 2, 'close still runs on cycle 2');
  assert.equal(dispatches, 2, 'dispatch still runs on cycle 2');
  assert.deepEqual(c2.metrics.steps, ['snapshot', 'close', 'dispatch', 'persist']);
  assert.equal(standingStepFailures(state).length, 1, 'status still shows one line on cycle 2');

  // Cycle 3: still running — skipped again, while close and dispatch still run.
  clock += 30_000;
  const c3 = await runCycle(config, state, effects, () => clock, undefined, line => lines.push(line));
  assert.equal(mergeEntries, 1, 'merge step is NOT re-entered on cycle 3 while cycle 1 body is still running');
  assert.equal(closes, 3, 'close still runs on cycle 3');
  assert.equal(dispatches, 3, 'dispatch still runs on cycle 3');
  assert.deepEqual(c3.metrics.steps, ['snapshot', 'close', 'dispatch', 'persist']);

  // Now the cycle 1 body settles; status clears and cycle 4 enters merge writer again.
  releaseMerge();
  await settle();
  assert.equal(standingStepFailures(state).length, 0, 'status clears once the running step settles');
  clock += 30_000;
  await runCycle(config, state, effects, () => clock, undefined, line => lines.push(line));
  assert.equal(mergeEntries, 2, 'merge step is entered again on cycle 4 after the old body settled');
});

test('unit:a-flying-head-is-not-started-twice — a head offered twice in overlapping merge steps gets one trial, and an open intent is not started again', async () => {
  const candidate = { sha: sha('head-overlap'), baseSha: tip, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker' };
  const work = makeItem({
    id: 'w7', key: 'GY-7', title: 'Submitted', stage: 'build', epoch: 1, submission: { epoch: 1, pr: 7 }, candidate,
    gates: gates(['ready', 'build', 'review', 'test']),
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: tip, baseTipContained: true, at: iso(start) },
  });
  let trials = 0, releaseServe!: () => void, serveCalls = 0;
  const gate = new Promise<null>(resolve => { releaseServe = () => resolve(null); });
  const events: MergeRecordEvent[] = [];
  const ports: MergePorts = {
    baseBranch: 'main', now: () => start,
    fetch: async () => tip,
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src/app.ts'] }),
    trial: async () => { trials += 1; return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }; },
    push: async () => 'pushed',
    holds: async () => false,
    record: async (_target, event) => { events.push(event); },
  };
  const reads: MergeWriterReads = {
    ...ports,
    memory: () => { serveCalls += 1; return gate; },
  };
  const state = emptyDaemonState(config);
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [work], now: iso(start) }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {},
    mergeWriter: reads,
    persist: async () => {},
  };
  const makeCycle = () => ({
    config, state, effects, now: () => start, snapshot: { work: [work], now: iso(start) }, clock: start,
    herdr: { agents: [], available: true }, credentials: {}, performed: [], launcher: {} as never,
    reservedProfiles: new Set<string>(), log: () => {},
  });

  // Two overlapping mergeWriterStep calls both see an empty `live` set before reaching startMergeFlight.
  const first = mergeWriterStep(makeCycle());
  const second = mergeWriterStep(makeCycle());
  await settle();
  assert.equal(serveCalls, 2, 'both overlapping merge steps are in flight together');
  releaseServe();
  await Promise.all([first, second]);
  await mergeWriterIdle(state);
  assert.equal(trials, 1, 'a head offered twice in overlapping steps gets one trial, not two');
  assert.equal(events.filter(event => event.kind === 'intent').length, 1, 'one intent recorded');
  assert.equal(events.filter(event => event.kind === 'trial').length, 1, 'one trial verdict recorded');
});

const waitFor = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, ms = 60_000): Promise<T> => {
  const begun = Date.now();
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(Date.now() - begun < ms, label + ': ' + JSON.stringify(value));
    await delay(100);
  }
};

test('integration:stuck-step-exits-and-trial-is-adopted-once — a first loop whose merge step never settles exits non-zero after the bound while a trial runs, a second loop adopts it, and the trial reaches one verdict', { timeout: 120_000 }, async () => {
  const world = await pipelineWorld('stuck-step-adopt');
  const cursor = join(world.root, 'cursor.json');
  await mkdir(world.trials, { recursive: true });
  const item = await world.submit('Slow trial under stuck step', { 'item.txt': 'item\n' });
  let child: ChildProcess | undefined, firstLogs = '', secondLogs = '';
  const spawnLoop = (hangMergeAfterTrialStart: boolean, onErr: (chunk: string) => void) => {
    const proc = spawn(process.execPath, [
      '--import', 'tsx',
      fileURLToPath(new URL('./helpers/stuck-step-process.ts', import.meta.url)),
      JSON.stringify({ checkout: world.checkout, trials: world.trials, url: world.url, config: world.config, database: world.database, cursor, hangMergeAfterTrialStart, stuckBoundMs: 1_500 }),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr!.on('data', data => onErr(String(data)));
    return proc;
  };
  const stop = async (proc?: ChildProcess) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = once(proc, 'exit');
    proc.kill('SIGTERM');
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2_000);
    await exited; clearTimeout(timer);
  };
  const readCursor = async () => { try { return JSON.parse(await readFile(cursor, 'utf8')); } catch { return null; } };
  try {
    // Process 1: starts the detached trial, then hangs inside the merge writer step forever.
    child = spawnLoop(true, chunk => { firstLogs += chunk; });
    const firstExit = once(child, 'exit');
    await waitFor(readCursor, value => value?.mergeWriter?.inFlight?.step === 'tests', 'first loop starts trial');
    const commandsPath = join(world.trials, 'commands.jsonl');
    const commands = async () => (await readFile(commandsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    await waitFor(commands, rows => rows.some(row => row.step === 'tests'), 'detached trial reached tests');
    const initial = (await readCursor())!.mergeWriter.inFlight!;

    // Process 1 must exit non-zero after the shortened bound, logging the stuck step.
    const [code] = await Promise.race([
      firstExit,
      delay(15_000).then(() => { throw new Error(`first loop did not exit on stuck step; stderr: ${firstLogs}`); }),
    ]);
    assert.ok(typeof code === 'number' && code !== 0, `expected non-zero exit code, got ${code}; stderr: ${firstLogs}`);
    assert.ok(firstLogs.includes('merge writer'), `expected stuck step logged; stderr: ${firstLogs}`);

    // Process 2: adopts the running detached trial and finishes it to one verdict.
    child = spawnLoop(false, chunk => { secondLogs += chunk; });
    const adopted = await waitFor(readCursor, value => Boolean(value?.actions?.['merge-writer-trial-adoption']) && value.mergeWriter?.inFlight?.step === 'tests', 'second loop adopts running trial');
    assert.equal(adopted.mergeWriter.inFlight.attempt, initial.attempt, secondLogs);
    assert.deepEqual(adopted.mergeWriter.inFlight.run, initial.run, secondLogs);

    await writeFile(join(world.trials, 'release'), '');
    await waitFor(world.work, work => work.find(entry => entry.id === item.id)?.mergeLedger?.state === 'reconciled', 'adopted trial completes: ' + secondLogs);
    const events = await world.store.events(item.id);
    assert.equal(events.filter(event => event.kind === 'merge.trial').length, 1, 'exactly one trial verdict, never two');
    assert.equal(events.filter(event => event.kind === 'merge.pushed').length, 1, 'exactly one push');
    assert.equal((await readdir(trialRunsDirectory(world.checkout))).length, 1, 'one detached trial run');
    assert.equal((await world.work()).find(entry => entry.id === item.id)!.mergeLedger!.mergeSha, world.main());
  } finally {
    await stop(child);
    for (const name of await readdir(trialRunsDirectory(world.checkout)).catch(() => []))
      await stopTrialRun({ directory: join(trialRunsDirectory(world.checkout), name) });
    await world.close();
  }
});
