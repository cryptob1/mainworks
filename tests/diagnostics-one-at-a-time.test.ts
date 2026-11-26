// GY-3811: after a deploy/restart, the loop collects the unfinished detached diagnostics run
// already going (even when verified has advanced to a newer commit, or when main-gate.json has no
// diagnosticsTrials entry for the run on disk) instead of starting another full run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { gateTrialKey } from '../src/merge-writer/trial-load.js';
import { trialRunFiles, trialRunsDirectory, type TrialRunHandle, type TrialRunRequest, type TrialRunSpec } from '../src/merge-writer/trial-run.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

const repository = 'owner/project';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;

async function fixture(label: string) {
  const { root: checkout, head: verified } = await gitRepo({ label, origin: true, files: { 'e2e/cases/smoke.json': '{}' } });
  await writeGateRecord(gateRecordPath(checkout), { ...bootstrapGate(repository, verified), diagnosticsAt: '2026-11-18T04:14:18.630Z' });
  return { checkout, verified };
}

/** Advance origin/main and record.verified, as a deploy after a verified batch does before restarting the loop. */
async function deployNewCommit(checkout: string, name: string) {
  await writeFile(join(checkout, `${name}.txt`), `${name}\n`);
  git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', name); git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(checkout, 'rev-parse', 'HEAD');
  const record = readGateRecord(gateRecordPath(checkout))!;
  await writeGateRecord(gateRecordPath(checkout), { ...record, verified: tip, verifiedAt: new Date().toISOString() });
  return tip;
}

const passing = (request: Pick<TrialRunRequest, 'proofs'>) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
  e2e: request.proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) }) as unknown as MergeTrialRun;

interface DeferredRun {
  request: TrialRunRequest;
  settled: boolean;
  waiters: ((run: MergeTrialRun) => void)[];
}

function world(checkout: string) {
  const runs = new Map<string, DeferredRun>();
  const launched: string[] = [];
  const adopted: string[] = [];
  let activeLoop = 0;

  const watch = (directory: string, loopId: number): TrialRunHandle => {
    const entry = runs.get(directory)!;
    return {
      directory,
      mergeSha: entry.request.mergeSha,
      trial: () => entry.settled
        ? Promise.resolve(passing(entry.request))
        : new Promise<MergeTrialRun>(resolve => {
            entry.waiters.push(run => { if (loopId === activeLoop) resolve(run); });
          }),
      detach: () => {},
      cancel: () => {},
    };
  };

  const finish = (directory: string) => {
    const entry = runs.get(directory)!;
    entry.settled = true;
    const verdict = passing(entry.request);
    for (const resolve of entry.waiters.splice(0)) resolve(verdict);
  };

  const registerExternal = (directory: string, request: TrialRunRequest) => {
    runs.set(directory, { request, settled: false, waiters: [] });
  };

  const reads = (loopId: number): MergeWriterReads => ({
    baseBranch: 'main', now: Date.now,
    fetch: async () => { git(checkout, 'fetch', '-q', 'origin', 'main'); return git(checkout, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async () => { throw new Error('diagnostics should run detached, not in-process'); },
    launchTrialRun: request => {
      const directory = join(trialRunsDirectory(checkout), `diagnostics-${runs.size + 1}`);
      const isSuite = request.changedFiles.includes('package.json');
      runs.set(directory, { request, settled: !isSuite, waiters: [] });
      launched.push(directory);
      return watch(directory, loopId);
    },
    adoptTrialRun: async ref => {
      const entry = runs.get(ref.directory);
      if (!entry || entry.request.mergeSha !== ref.mergeSha) return null;
      adopted.push(ref.directory);
      return watch(ref.directory, loopId);
    },
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    createWork: async () => ({ key: 'GY-900' }),
    gate: { root: checkout, repository },
  } as MergeWriterReads);

  const loop = () => {
    const id = ++activeLoop;
    return { state: emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as never), effects: { mergeWriter: reads(id) } as never, snapshot: { work: [], now: new Date().toISOString() } as never, performed: [], now: Date.now, log: () => {} };
  };

  const suiteRuns = () => [...runs.values()].filter(entry => entry.request.changedFiles.includes('package.json')).length;

  return { runs, launched, adopted, loop, finish, registerExternal, suiteRuns };
}

async function until(condition: () => boolean, what: string) {
  for (const deadline = Date.now() + 10_000; !condition();) {
    if (Date.now() > deadline) assert.fail(`timed out waiting: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('integration:diagnostics-one-at-a-time — three loop restarts while one detached diagnostics run is unfinished start no further run, and its result is recorded when it ends', async () => {
  const { checkout } = await fixture('diagnostics-one-at-a-time');
  const line = world(checkout);

  // Loop 1 starts the detached diagnostics full-suite run; it stays unfinished.
  const first = await batchGateStep(line.loop());
  await first!.gate;
  await until(() => line.launched.length === 1, 'loop 1 launches one diagnostics run');
  const firstDir = line.launched[0]!;
  await until(() => (readGateRecord(gateRecordPath(checkout))!.diagnosticsTrials ?? []).length === 1, 'the run rides the record');

  // Three deploy restarts advance verified while the first detached run is still unfinished.
  let lastStep: Awaited<ReturnType<typeof batchGateStep>> = null;
  for (let restart = 1; restart <= 3; restart++) {
    await deployNewCommit(checkout, `deploy-${restart}`);
    const adoptionsBefore = line.adopted.length;
    const launchesBefore = line.launched.length;
    lastStep = await batchGateStep(line.loop());
    await lastStep!.gate;
    await until(() => line.adopted.length > adoptionsBefore || line.launched.length > launchesBefore, `restart ${restart} checks diagnostics`);
    assert.equal(line.suiteRuns(), 1, `restart ${restart} must not start another full-suite diagnostics run`);
    assert.equal(line.launched.length, 1, `restart ${restart} launched no new run`);
  }

  // The original unfinished run ends: the active loop collects it, finishes the catalog, and records the result.
  line.finish(firstDir);
  await lastStep!.diagnostics;

  const record = readGateRecord(gateRecordPath(checkout))!;
  assert.equal(line.suiteRuns(), 1, 'only one full-suite diagnostics run ever started');
  assert.ok(Date.now() - Date.parse(record.diagnosticsAt!) < 60_000, `diagnosticsAt ${record.diagnosticsAt}`);
  assert.equal(record.diagnosticsRun?.outcome, 'passed');
  assert.equal(record.diagnosticsRun?.at, record.diagnosticsAt);
  assert.deepEqual(record.diagnosticsTrials ?? [], [], 'completed diagnostics clear diagnosticsTrials');
});

test('integration:diagnostics-one-at-a-time — an unfinished detached diagnostics run on disk (no exit file) is adopted even without diagnosticsTrials in main-gate.json', async () => {
  const { checkout, verified } = await fixture('diagnostics-one-at-a-time-disk');
  const line = world(checkout);

  // Seed an unfinished detached diagnostics run directory on disk (spec key batch-gate, no exit file),
  // with main-gate.json already moved to a newer verified commit and no diagnosticsTrials entry.
  const dir = join(trialRunsDirectory(checkout), '1e7848a2-unfinished');
  await mkdir(dir, { recursive: true });
  const request: TrialRunRequest = {
    key: gateTrialKey, head: verified, mergeSha: verified, baseTip: verified,
    changedFiles: ['package.json'], proofs: [], e2eProofs: [], timeoutMs: 45 * 60_000, reproduce: true, cores: null,
  };
  const spec: TrialRunSpec = { version: 1, ...request, root: checkout, base: checkout, hidden: [], startedAt: new Date().toISOString() };
  await writeFile(trialRunFiles(dir).spec, `${JSON.stringify(spec)}\n`);
  line.registerExternal(dir, request);

  let lastStep: Awaited<ReturnType<typeof batchGateStep>> = null;
  for (let restart = 1; restart <= 3; restart++) {
    await deployNewCommit(checkout, `disk-deploy-${restart}`);
    const adoptionsBefore = line.adopted.length;
    const launchesBefore = line.launched.length;
    lastStep = await batchGateStep(line.loop());
    await lastStep!.gate;
    await until(() => line.adopted.length > adoptionsBefore || line.launched.length > launchesBefore, `disk restart ${restart} checks diagnostics`);
    assert.equal(line.suiteRuns(), 1, `disk restart ${restart} must adopt the existing run, not launch another`);
    assert.equal(line.launched.length, 0, `disk restart ${restart} launched no new suite run`);
    await until(() => (readGateRecord(gateRecordPath(checkout))!.diagnosticsTrials ?? []).length === 1, `disk restart ${restart} persists adopted run`);
  }

  line.finish(dir);
  await lastStep!.diagnostics;

  const record = readGateRecord(gateRecordPath(checkout))!;
  assert.equal(line.suiteRuns(), 1, 'still only the original unfinished run');
  assert.ok(Date.now() - Date.parse(record.diagnosticsAt!) < 60_000, `diagnosticsAt ${record.diagnosticsAt}`);
  assert.equal(record.diagnosticsRun?.outcome, 'passed');
  assert.equal(record.diagnosticsRun?.at, record.diagnosticsAt);
});

test('e2e:diagnostics-one-at-a-time — on a running test install a loop restart during a diagnostics run leaves exactly one diagnostics run and its result appears in master status', async () => {
  const { checkout } = await fixture('diagnostics-one-at-a-time-e2e');
  const line = world(checkout);

  const first = await batchGateStep(line.loop());
  await first!.gate;
  await until(() => line.launched.length === 1, 'first loop launches diagnostics');
  const firstDir = line.launched[0]!;
  await until(() => (readGateRecord(gateRecordPath(checkout))!.diagnosticsTrials ?? []).length === 1, 'the run rides the record');

  // Deploy a new verified commit and restart the loop mid-run.
  await deployNewCommit(checkout, 'deployed-while-running');
  const adoptionsBefore = line.adopted.length;
  const launchesBefore = line.launched.length;
  const second = await batchGateStep(line.loop());
  await second!.gate;
  await until(() => line.adopted.length > adoptionsBefore || line.launched.length > launchesBefore, 'restarted loop handles diagnostics');
  assert.equal(line.suiteRuns(), 1, 'exactly one diagnostics full-suite run exists across the restart');

  line.finish(firstDir);
  await second!.diagnostics;

  const credentials = await temporaryDirectory('diagnostics-one-at-a-time-credentials');
  const config = { url: 'http://127.0.0.1:5', repository, credentialFile: join(credentials, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const report = await masterStatusReport(checkout, config, async () => ({ work: [], now: new Date().toISOString() }), (command: string, args: string[]) => command === 'git' ? execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : '') as unknown as { attention: { text: string }[]; batchGate: { diagnosticsAt: string; diagnostics: { at: string; outcome: string } } };
  assert.equal(line.suiteRuns(), 1);
  assert.ok(Date.now() - Date.parse(report.batchGate.diagnosticsAt) < 60_000);
  assert.equal(report.batchGate.diagnostics.outcome, 'passed');
  assert.equal(report.batchGate.diagnostics.at, report.batchGate.diagnosticsAt);
  assert.ok(!report.attention.some(line => /Daily diagnostics/.test(line.text)), 'fresh diagnostics raise no stale line');
});
