import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateLimitMs, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import { heavyTrial, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { declarationSlot, heldSlots, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { until } from './helpers/until.js';

// GY-3606: a gate timed out while its failed check was being rerun, and the rerun's heavy-job slot
// was still held an hour later. A gate run that records timeout leaves no holder and no running test.

const repository = 'owner/project';
const start = Date.parse('2030-05-01T00:00:00Z');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], e2e: [] } as unknown as MergeTrialRun;
const failing = { ...passing, build: 'fail' } as unknown as MergeTrialRun;

const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });
const holders = (directory: string) => heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(entry => entry.owner?.label);

/** One test process per check run, live until its signal or its run's cancel stops it. */
type Check = { call: number; commit: string; signal?: AbortSignal; stopped: boolean };

/**
 * A gate over main's one new merge with one host heavy-job slot. Its checks on main's tip run
 * detached, each after a trial image build (`image`); its probes on the verified commit trial in
 * process under their own hold, as the merge writer's do. `verdict` answers each check, or hangs.
 */
async function world(label: string, options: { image?: (call: number) => Promise<void>; verdict: (check: Check) => Promise<MergeTrialRun> | null }) {
  const base = await temporaryDirectory(label);
  const slots = join(base, 'heavy-jobs');
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, 'limit'), '1\n');
  process.env[slotsDirectoryVariable] = slots;
  const coordinator = join(base, 'coordinator');
  const { root: pusher, origin, head: verified } = await gitRepo({ root: join(base, 'pusher'), files: { 'graphyard.json': '{}' }, origin: true });
  await writeFile(join(pusher, 'f1.ts'), 'ok\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'change 1'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeGateRecord(gateRecordPath(coordinator), { ...bootstrapGate(repository, verified), diagnosticsAt: new Date(start).toISOString() });
  let clock = start, images = 0;
  const checks: Check[] = [];
  const check = (commit: string, signal?: AbortSignal) => {
    const entry: Check = { call: checks.length + 1, commit, stopped: false };
    checks.push(entry);
    return entry;
  };
  const answer = (entry: Check, signal?: AbortSignal) => {
    entry.signal = signal;
    const verdict = options.verdict(entry);
    if (verdict) return verdict.finally(() => { entry.stopped = true; });
    return new Promise<MergeTrialRun>((_, reject) => {
      const stop = () => { entry.stopped = true; reject(signal?.reason ?? new Error('cancelled')); };
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    });
  };
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock, cores: 2, parallel: 1,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('the gate merges nothing'); },
    trial: (commit, _files, item, _base, step, _timing, _heads, _share, signal) => heavyTrial(item.key, step, signal, () => answer(check(commit), signal)),
    ensureTrialImage: () => options.image?.(++images) ?? Promise.resolve(),
    launchTrialRun: request => {
      const entry = check(request.mergeSha);
      return { directory: join(base, 'runs', String(entry.call)), mergeSha: request.mergeSha, trial: (_step, _timing, signal) => answer(entry, signal),
        detach: () => {}, cancel: () => { entry.stopped = true; } };
    },
    adoptTrialRun: async () => null,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: coordinator, repository, slots: join(base, 'trial-slots') },
  };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
  const cycle = { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: new Date(start).toISOString() } as any, performed: [], now: () => clock, log: () => {} };
  return { slots, coordinator, tip, verified, cycle, checks, images: () => images, advance: (ms: number) => { clock += ms; },
    record: () => readGateRecord(gateRecordPath(coordinator))! };
}

const failingTest = { ...passing, tests: { passed: 0, failed: ['f1.ts'], files: 1 } } as unknown as MergeTrialRun;
const running = (checks: Check[]) => checks.filter(entry => !entry.stopped).map(entry => entry.call);

test('integration:gate-rerun-releases-slot — a gate that times out while rerunning or probing a failed check leaves no heavy-job holder and no running test of that run, and the next run starts at once', { timeout: 60_000 }, async () => {
  // The build fails, and its rerun runs past the gate's bound; the retry on main passes.
  {
    const yard = await world('gate-rerun-slot', { verdict: entry => entry.call === 1 ? Promise.resolve(failing) : entry.call === 2 ? null : Promise.resolve(passing) });
    const flight = (await batchGateStep(yard.cycle))!.gate!;
    await until(() => yard.checks.length === 2, 'the gate reruns its failed build', 15_000);
    assert.deepEqual(holders(yard.slots), ['test merge batch-gate'], 'the rerun holds the slot');
    yard.advance(gateLimitMs + 1);
    await until(() => yard.checks.length === 3, 'the next gate run starts its check without waiting on the timed-out rerun', 15_000);
    await flight;
    assert.equal(yard.record().verified, yard.tip, 'the retry verified main');
    assert.deepEqual(running(yard.checks), [], 'the timed-out rerun\'s tests were stopped');
    assert.deepEqual(holders(yard.slots), [], 'no heavy-job holder is left behind');
  }

  // A test fails twice, and its probe on the verified commit runs past the gate's bound.
  {
    const yard = await world('gate-probe-slot', { verdict: entry => entry.commit === yard.verified ? null : Promise.resolve(entry.call <= 2 ? failingTest : passing) });
    const flight = (await batchGateStep(yard.cycle))!.gate!;
    await until(() => yard.checks.some(entry => entry.commit === yard.verified), 'the gate probes the failed test on the verified commit', 15_000);
    assert.deepEqual(holders(yard.slots), ['test merge batch-gate'], 'the probe holds a slot');
    yard.advance(gateLimitMs + 1);
    await until(() => yard.checks.length === 4, 'the next gate run starts its check without waiting on the timed-out probe', 15_000);
    await flight;
    assert.equal(yard.record().verified, yard.tip, 'the retry verified main');
    assert.deepEqual(running(yard.checks), [], 'the timed-out probe\'s tests were stopped');
    assert.deepEqual(holders(yard.slots), [], 'no heavy-job holder is left behind');
  }

  // The build fails, and the gate times out while its rerun's trial image is still building: once
  // the build settles, the timed-out rerun starts no tests and writes nothing onto the record.
  {
    let finishImage!: () => void;
    const hung = new Promise<void>(resolve => { finishImage = resolve; });
    const yard = await world('gate-rerun-image', { image: call => call === 2 ? hung : Promise.resolve(), verdict: entry => Promise.resolve(entry.call === 1 ? failing : passing) });
    const flight = (await batchGateStep(yard.cycle))!.gate!;
    await until(() => yard.images() === 2, 'the gate\'s rerun builds the trial image', 15_000);
    assert.deepEqual(holders(yard.slots), ['test merge batch-gate'], 'the rerun holds the slot');
    yard.advance(gateLimitMs + 1);
    await until(() => yard.checks.length === 2, 'the next gate run starts its check without waiting on the timed-out rerun', 15_000);
    await flight;
    assert.equal(yard.record().verified, yard.tip, 'the retry verified main');
    finishImage();
    await sleep(300);
    assert.equal(yard.checks.length, 2, 'the timed-out rerun launched no tests once its image was built');
    assert.equal(yard.record().inFlight, null, 'the settled record carries no run of the timed-out rerun');
    assert.deepEqual(running(yard.checks), []);
    assert.deepEqual(holders(yard.slots), [], 'no heavy-job holder is left behind');
  }
});
