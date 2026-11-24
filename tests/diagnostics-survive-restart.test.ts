// GY-3805: the daily diagnostics run detached, as the gate's checks and merge trials do. Deploys
// restarted the loop every 20 to 60 minutes while a run needs about 55, so no run ever finished;
// now a restart leaves the run going and the next loop collects its result instead of starting over.
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
import type { TrialRunHandle, TrialRunRequest } from '../src/merge-writer/trial-run.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const repository = 'owner/project';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();

/** A checkout whose verified main holds one case; its diagnostics are six days old. */
async function fixture(label: string) {
  const base = await temporaryDirectory(label), origin = join(base, 'origin.git'), checkout = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, checkout);
  await mkdir(join(checkout, 'e2e', 'cases'), { recursive: true });
  await writeFile(join(checkout, 'e2e', 'cases', 'smoke.json'), '{}');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'base'); git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  const verified = git(checkout, 'rev-parse', 'HEAD');
  await writeGateRecord(gateRecordPath(checkout), { ...bootstrapGate(repository, verified), diagnosticsAt: '2026-11-18T04:14:18.630Z' });
  return { checkout, verified };
}

const passing = (request: TrialRunRequest) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
  e2e: request.proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) }) as unknown as MergeTrialRun;

/**
 * Two loops over one checkout: detached runs live in `runs` (directory → its request and verdict),
 * which outlives either loop. The first loop's runs never finish while it lives; after the restart
 * every run has its verdict, as a run that finished while the loop was down does, and the
 * second loop's own launches finish.
 */
function world(checkout: string) {
  const runs = new Map<string, { request: TrialRunRequest }>(), inProcess: string[] = [], launched: string[] = [];
  let loops = 0;
  const handle = (directory: string, result: Promise<MergeTrialRun>): TrialRunHandle => ({ directory, mergeSha: runs.get(directory)!.request.mergeSha, trial: () => result, detach: () => {}, cancel: () => {} });
  const reads = (restarted: boolean): MergeWriterReads => ({
    baseBranch: 'main', now: Date.now,
    fetch: async () => { git(checkout, 'fetch', '-q', 'origin', 'main'); return git(checkout, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async commit => { inProcess.push(commit); return new Promise<MergeTrialRun>(() => {}); },
    launchTrialRun: request => {
      const directory = `/runs/diagnostics-${runs.size + 1}`;
      runs.set(directory, { request });
      launched.push(directory);
      return handle(directory, restarted ? Promise.resolve(passing(request)) : new Promise<MergeTrialRun>(() => {}));
    },
    adoptTrialRun: async ref => {
      const run = runs.get(ref.directory);
      return run && run.request.mergeSha === ref.mergeSha ? handle(ref.directory, Promise.resolve(passing(run.request))) : null;
    },
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    createWork: async () => ({ key: 'GY-900' }),
    gate: { root: checkout, repository },
  } as MergeWriterReads);
  const loop = () => ({ state: emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as never), effects: { mergeWriter: reads(loops++ > 0) } as never, snapshot: { work: [], now: new Date().toISOString() } as never, performed: [], now: Date.now, log: () => {} });
  return { runs, inProcess, launched, loop };
}

async function until(condition: () => boolean, what: string) {
  for (const deadline = Date.now() + 10_000; !condition();) {
    if (Date.now() > deadline) assert.fail(`timed out waiting: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function restartMidRun(label: string) {
  const { checkout, verified } = await fixture(label);
  const line = world(checkout);
  // The first loop starts the day's diagnostics; its suite trial launches detached and is still running when the loop restarts.
  const first = await batchGateStep(line.loop());
  await first!.gate;
  await until(() => line.launched.length > 0 || line.inProcess.length > 0, 'the diagnostics start a trial');
  assert.deepEqual(line.inProcess, [], 'the diagnostics trial runs detached, not inside the loop');
  await until(() => (readGateRecord(gateRecordPath(checkout))!.diagnosticsTrials ?? []).length === 1, 'the run rides the record');
  // A deploy restarts the loop; the run finishes meanwhile and the new loop collects it.
  const second = await batchGateStep(line.loop());
  await second!.diagnostics; await second!.gate;
  return { checkout, verified, line };
}

test('integration:diagnostics-survive-restart — a diagnostics run started before a loop restart is collected after it: one completed run is recorded and the suite is not started again', async () => {
  const { checkout, verified, line } = await restartMidRun('diagnostics-survive-restart');
  const record = readGateRecord(gateRecordPath(checkout))!;
  assert.ok(Date.now() - Date.parse(record.diagnosticsAt!) < 60_000, `diagnosticsAt ${record.diagnosticsAt}`);
  assert.equal(record.diagnosticsRun?.outcome, 'passed');
  assert.equal(record.diagnosticsRun?.at, record.diagnosticsAt);
  const suites = [...line.runs.values()].filter(run => run.request.changedFiles.includes('package.json'));
  assert.equal(suites.length, 1, 'the full suite launched once across the restart');
  assert.ok([...line.runs.values()].every(run => run.request.head === verified), 'every run trials the verified commit');
  assert.deepEqual(line.inProcess, []);
  assert.deepEqual(record.diagnosticsTrials ?? [], [], 'a completed run leaves no runs to collect');
});

test('e2e:diagnostics-survive-restart — on a running test install a diagnostics run survives one loop restart and master status shows its time and outcome', async () => {
  const { checkout } = await restartMidRun('diagnostics-survive-restart-e2e');
  const credentials = await temporaryDirectory('diagnostics-survive-restart-credentials');
  const config = { url: 'http://127.0.0.1:5', repository, credentialFile: join(credentials, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const report = await masterStatusReport(checkout, config, async () => ({ work: [], now: new Date().toISOString() }), (command: string, args: string[]) => command === 'git' ? execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : '') as unknown as { attention: { text: string }[]; batchGate: { diagnosticsAt: string; diagnostics: { at: string; outcome: string } } };
  assert.ok(Date.now() - Date.parse(report.batchGate.diagnosticsAt) < 60_000);
  assert.equal(report.batchGate.diagnostics.outcome, 'passed');
  assert.equal(report.batchGate.diagnostics.at, report.batchGate.diagnosticsAt);
  assert.ok(!report.attention.some(line => /Daily diagnostics/.test(line.text)), 'fresh diagnostics raise no line');
});
