import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { TrialHeatError } from '../src/merge-writer/trial-load.js';
import { serializeTrialError } from '../src/merge-writer/trial-run.js';
import { acquireVerificationSlot, projectVariable, setStrictCap, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3803: the batch gate takes the next freed heavy-job slot ahead of merge trials, and a batch
// gate whose run fails as slowed by heat reruns only its failed files on the next cycle.

const repository = 'owner/project';
const start = Date.parse('2030-07-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 15_000) {
  for (const deadline = Date.now() + timeoutMs; !condition();) { assert.ok(Date.now() < deadline, `timed out waiting until ${what}`); await sleep(20); }
}
const passing = { build: 'pass', tests: { passed: 2, failed: [], files: 2 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;

const previousSlots = process.env[slotsDirectoryVariable];
const previousProject = process.env[projectVariable];
after(() => {
  if (previousSlots === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previousSlots;
  if (previousProject === undefined) delete process.env[projectVariable]; else process.env[projectVariable] = previousProject;
});

async function repoWorld(label: string, onLaunch: (request: { key: string; mergeSha: string; changedFiles: string[]; proofs: string[]; e2eProofs: string[] }) => Promise<MergeTrialRun>) {
  const base = await temporaryDirectory(label);
  const slots = join(base, 'heavy-jobs');
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, 'limit'), '2\n');
  process.env[slotsDirectoryVariable] = slots;
  process.env[projectVariable] = repository;
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await writeFile(join(pusher, 'graphyard.json'), '{}');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'base'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  await writeFile(join(pusher, 'src-a.ts'), 'export const a = 1;\n');
  await writeFile(join(pusher, 'src-b.ts'), 'export const b = 2;\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'change 1'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  const file = gateRecordPath(coordinator);
  await writeGateRecord(file, { ...bootstrapGate(repository, verified), diagnosticsAt: iso(start) });
  let launchCount = 0;
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => start, cores: 4, parallel: 2,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async head => ({ mergeSha: sha(`merge:${head}`), files: ['src-a.ts', 'src-b.ts'] }),
    trial: async () => { throw new Error('every gate check runs detached'); },
    ensureTrialImage: async () => {},
    launchTrialRun: request => {
      const directory = join(base, 'runs', `run-${++launchCount}`);
      const answer = onLaunch(request);
      answer.catch(() => undefined);
      return { directory, mergeSha: request.mergeSha, trial: () => answer, detach: () => {}, cancel: () => {} };
    },
    adoptTrialRun: async () => null,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    gate: { root: coordinator, repository, slots: join(base, 'trial-slots') },
  };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any);
  const cycle = { state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(start) } as any, performed: [], now: () => start, log: () => {} };
  return { base, slots, file, verified, tip, state, cycle };
}

test('e2e:batch-gate-slot-priority — with every heavy-job slot held by merge trials and a batch gate waiting, the first freed slot goes to the batch gate and no new merge trial starts before it; a heat-slowed batch gate reruns only its failed files on the next cycle and verifies when they pass', { timeout: 120_000 }, async () => {
  // Part 1: every heavy-job slot held by merge trials (under a strict cap of 2 so the batch gate
  // shares the queue), another project's merge trial and a same-project merge trial waiting too:
  // when a slot frees, the batch gate takes it first and no new merge trial starts before it.
  {
    const order: string[] = [];
    const yard = await repoWorld('gate-slot-priority', async () => {
      order.push('batch-gate');
      return passing;
    });
    setStrictCap(yard.slots, { value: 2, until: iso(Date.now() + 3600_000) }, 'graphyard-master');
    const held1 = await acquireVerificationSlot({ directory: yard.slots, label: 'test merge GY-1', project: repository });
    const held2 = await acquireVerificationSlot({ directory: yard.slots, label: 'test merge GY-2', project: repository });

    const stop = new AbortController();
    let otherWaiting = false, sameWaiting = false;
    const otherTrial = acquireVerificationSlot({ directory: yard.slots, label: 'test merge OTHER-1', project: 'other/project', pollMs: 20, signal: stop.signal, onWait: () => { otherWaiting = true; } })
      .then(slot => { order.push('OTHER-1'); return slot; });
    const sameTrial = acquireVerificationSlot({ directory: yard.slots, label: 'test merge GY-3', project: repository, pollMs: 20, signal: stop.signal, onWait: () => { sameWaiting = true; } })
      .then(slot => { order.push('GY-3'); return slot; });
    otherTrial.catch(() => {}); sameTrial.catch(() => {});
    await until(() => otherWaiting && sameWaiting, 'queued merge trials wait');

    const gateFlight = (await batchGateStep(yard.cycle))!.gate!;
    await until(() => (readGateRecord(yard.file)?.inFlight?.progress ?? '').includes('waiting for a host heavy-job slot'), 'batch gate waits for a host heavy-job slot');

    // Free one slot: the batch gate must take it ahead of both queued merge trials.
    try {
      held1.release();
      await until(() => order.length > 0, 'first freed slot is taken');
      assert.equal(order[0], 'batch-gate', `the batch gate takes the first freed slot ahead of merge trials (got ${JSON.stringify(order)})`);
      await gateFlight;
      assert.equal(readGateRecord(yard.file)?.verified, yard.tip, 'the batch gate verified main');
    } finally {
      held2.release();
      stop.abort();
      for (const pending of [otherTrial, sameTrial]) (await pending.catch(() => null))?.release();
    }
  }

  // Part 2: a batch gate whose run fails as slowed by heat reruns only its failed files on the
  // next cycle and verifies when they pass.
  {
    const launches: { changedFiles: string[]; proofs: string[]; e2eProofs: string[] }[] = [];
    const failedFiles = ['tests/slow-one.test.ts', 'tests/slow-two.test.ts'];
    const yard = await repoWorld('gate-heat-rerun', async request => {
      launches.push({ changedFiles: [...request.changedFiles], proofs: [...request.proofs], e2eProofs: [...request.e2eProofs] });
      if (launches.length === 1) throw new TrialHeatError('tests', 65, failedFiles);
      return passing;
    });

    // Cycle 1: fails as slowed by heat with two failed test files.
    const first = (await batchGateStep(yard.cycle))!.gate!;
    await first;
    const afterHeat = readGateRecord(yard.file)!;
    assert.equal(afterHeat.verified, yard.verified, 'main is not verified after the heat failure');
    assert.equal(afterHeat.lastOutcome?.outcome, 'retry', 'the heat-slowed run settles as retry');
    assert.match(afterHeat.lastOutcome?.reason ?? '', /trial slowed by heat/);
    assert.deepEqual(afterHeat.inFlight?.checks, failedFiles.map(file => `test:${file}`), 'inFlight narrows to the failed files');

    // Cycle 2: reruns only those failed files (not the full changedFiles or e2e cases) and verifies.
    const second = (await batchGateStep(yard.cycle))!.gate!;
    await second;
    assert.equal(launches.length, 2, 'two gate runs launched');
    assert.deepEqual(launches[1]!.changedFiles, failedFiles, 'second cycle reruns only the failed files');
    assert.deepEqual(launches[1]!.e2eProofs, [], 'second cycle skips already-passed e2e cases');
    const afterPass = readGateRecord(yard.file)!;
    assert.equal(afterPass.verified, yard.tip, 'main verifies once the failed files pass');
    assert.equal(afterPass.lastOutcome?.outcome, 'verified');
    assert.equal(afterPass.inFlight, null);
  }
});

test('unit:trial-heat-error-serialization — TrialHeatError carries its failed files through serializeTrialError', () => {
  const error = new TrialHeatError('tests', 65, ['tests/a.test.ts', 'tests/b.test.ts']);
  const serialized = serializeTrialError(error, []);
  assert.equal(serialized.name, 'TrialHeatError');
  assert.deepEqual(serialized.files, ['tests/a.test.ts', 'tests/b.test.ts']);
});
