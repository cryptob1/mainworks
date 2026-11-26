import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import { heavyTrial, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { trialFileTimeoutMs } from '../src/merge-writer/trial-load.js';
import { declarationSlot, heldSlots, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3800: at 18:34Z and 19:58Z on 2026-11-24 a gate rerun was stopped for the per-file timeout,
// and the gate sat "probing" while merge trials held every ordinary host slot: the probe on the
// verified commit queued behind them although the stopped run had just freed the gate's own slot.
// The stopped run frees its slot, its file counts as failed, and the gate's next step takes that slot.

const repository = 'owner/project';
const start = Date.parse('2030-05-01T00:00:00Z');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 60_000) {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(20); }
}
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], e2e: [] } as unknown as MergeTrialRun;
const failingTest = { ...passing, tests: { passed: 0, failed: ['f1.ts'], files: 1 } } as unknown as MergeTrialRun;

const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });
const holders = (directory: string) => heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(entry => entry.owner?.label);

type Check = { call: number; commit: string; stopped: boolean };

/** A gate on main's one merge whose rerun of a failing test file never ends, with one host slot a merge trial holds throughout. */
async function gateWithHangingFile() {
  const base = await temporaryDirectory('gate-moves-after-file-timeout-');
  const slots = join(base, 'heavy-jobs');
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, 'limit'), '1\n');
  process.env[slotsDirectoryVariable] = slots;
  const coordinator = join(base, 'coordinator');
  const { root: pusher, origin } = await gitRepo({ root: join(base, 'pusher'), origin: true, files: { 'graphyard.json': '{}' } });
  const verified = git(pusher, 'rev-parse', 'HEAD');
  await writeFile(join(pusher, 'f1.ts'), 'ok\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'change 1'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  await writeGateRecord(gateRecordPath(coordinator), { ...bootstrapGate(repository, verified), diagnosticsAt: new Date(start).toISOString() });
  let clock = start;
  const checks: Check[] = [];
  // The main check fails f1.ts; its rerun reaches its test runner and never ends; the probe on the verified commit fails it too.
  const answer = (entry: Check, step?: (line: string) => void, signal?: AbortSignal): Promise<MergeTrialRun> => {
    if (entry.call !== 2) return Promise.resolve(failingTest).finally(() => { entry.stopped = true; });
    step?.('tests');
    return new Promise<MergeTrialRun>((_, reject) => {
      const stop = () => { entry.stopped = true; reject(signal?.reason ?? new Error('cancelled')); };
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    });
  };
  const check = (commit: string) => { const entry = { call: checks.length + 1, commit, stopped: false }; checks.push(entry); return entry; };
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock, cores: 2, parallel: 1,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('the gate merges nothing'); },
    trial: (commit, _files, item, _base, step, _timing, _heads, _share, signal) => heavyTrial(item.key, step, signal, () => answer(check(commit), step, signal)),
    ensureTrialImage: async () => {},
    launchTrialRun: request => {
      const entry = check(request.mergeSha);
      return { directory: join(base, 'runs', String(entry.call)), mergeSha: request.mergeSha, trial: (step, _timing, signal) => answer(entry, step, signal),
        detach: () => {}, cancel: () => { entry.stopped = true; } };
    },
    adoptTrialRun: async () => null,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: coordinator, repository, slots: join(base, 'trial-slots') },
  };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
  const cycle = { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: new Date(start).toISOString() } as any, performed: [], now: () => clock, log: () => {} };

  // A merge trial holds the host's one ordinary slot for the whole gate.
  let endMerge!: () => void;
  const merge = heavyTrial('GY-1', undefined, undefined, () => new Promise<void>(resolve => { endMerge = resolve; }));
  await until(() => holders(slots).includes('test merge GY-1'), 'a merge trial holds the ordinary slot');
  const flight = (await batchGateStep(cycle))!.gate!;
  await until(() => checks.length === 2, 'the gate reruns its failed test file');
  await until(() => readGateRecord(gateRecordPath(coordinator))?.inFlight?.progress === 'tests', 'the rerun reaches its test runner');
  assert.deepEqual(holders(slots).sort(), ['test merge GY-1', 'test merge batch-gate'], 'the rerun holds the gate\'s slot');
  clock += trialFileTimeoutMs + 1;
  const stoppedAt = Date.now();
  await until(() => checks.some(entry => entry.commit === verified), 'the gate probes the stopped file on the verified commit', 60_000);
  assert.ok(Date.now() - stoppedAt < 60_000);
  assert.ok(checks[1]!.stopped, 'the rerun that ran past the per-file timeout was stopped');
  await flight;
  const record = readGateRecord(gateRecordPath(coordinator))!;
  assert.equal(record.verified, tip, `the file fails on the verified commit too, so it is a known red and the batch verifies: ${JSON.stringify(record.lastOutcome)}`);
  assert.deepEqual(holders(slots), ['test merge GY-1'], 'no gate slot outlives its run');
  endMerge();
  await merge;
}

test('integration:gate-moves-after-file-timeout — a gate rerun whose test file never ends is stopped at the per-file timeout: its slot is free and the probe on the verified commit starts within 60 s while merge trials hold every other slot', { timeout: 120_000 }, gateWithHangingFile);

test('e2e:gate-moves-after-file-timeout — a gate whose test file hangs reaches an outcome without a loop restart', { timeout: 120_000 }, gateWithHangingFile);
