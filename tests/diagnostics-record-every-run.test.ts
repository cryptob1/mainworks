// GY-3779: the daily diagnostics record every run. A full-suite trial that crashed or timed out threw
// the whole run away — no diagnosticsAt, catalog time or onboarding minutes for six days — so a
// throwing trial is now one failed check, a run that still throws records why, and master status
// names diagnostics older than 30 hours.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapGate, diagnosticsAttention, gateRecordPath, gateSummary, readGateRecord, runDiagnostics, writeGateRecord } from '../src/batch-gate.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { TrialRunnerError } from '../src/merge-writer/trial.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { onboardingCase, type OnboardingRun } from '../src/onboarding-time.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

const own = 'integration:diagnostics-record-every-run';
const repository = 'owner/project';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;

/** A checkout whose main holds the onboarding case; the gate record says main is verified and the diagnostics are due. */
async function fixture(label: string) {
  const base = await temporaryDirectory(label), checkout = join(base, 'checkout');
  const { head: verified } = await gitRepo({ root: checkout, label, files: { 'e2e/cases/smoke.json': '{}', [`e2e/cases/${onboardingCase}.json`]: '{}' }, origin: true });
  await writeGateRecord(gateRecordPath(checkout), { ...bootstrapGate(repository, verified), diagnosticsAt: '2026-11-18T04:14:18.630Z' });
  return { checkout, verified };
}

function reads(checkout: string, options: { suite: () => never | void; onboarding: (commit: string) => Promise<OnboardingRun>; trials?: string[] }): MergeWriterReads {
  return {
    baseBranch: 'main', now: Date.now,
    fetch: async () => { git(checkout, 'fetch', '-q', 'origin', 'main'); return git(checkout, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async (commit, files, item) => {
      options.trials?.push(commit);
      if (files.includes('package.json')) options.suite();
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
    },
    push: async () => 'pushed', holds: async () => true, record: async () => undefined,
    createWork: async () => ({ key: 'GY-900' }),
    gate: { root: checkout, repository, onboarding: options.onboarding },
  } as MergeWriterReads;
}

const cycleWith = (mergeWriter: MergeWriterReads) =>
  ({ state: emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as never), effects: { mergeWriter } as never, snapshot: { work: [], now: new Date().toISOString() } as never, performed: [], now: Date.now, log: () => {} });

const onboarded = (commit: string): OnboardingRun => ({ at: new Date().toISOString(), commit, minutes: 6.5, result: 'passed', handFixes: [] });

test(`${own} — a full-suite trial that crashes is one failed check: the catalog and onboarding still run and the run records its time, catalog time, onboarding and outcome`, async () => {
  const { checkout, verified } = await fixture('diagnostics-suite-crash');
  const step = await batchGateStep(cycleWith(reads(checkout, {
    suite: () => { throw new TrialRunnerError('tests', null, null, [], 0, '', verified, 1); },
    onboarding: async commit => onboarded(commit),
  })));
  await step!.diagnostics; await step!.gate;
  const record = readGateRecord(gateRecordPath(checkout))!;
  assert.ok(Date.now() - Date.parse(record.diagnosticsAt!) < 60_000, `diagnosticsAt ${record.diagnosticsAt}`);
  assert.equal(typeof record.catalogMs, 'number');
  assert.equal(record.onboarding?.minutes, 6.5);
  const shown = gateSummary(record)!;
  assert.equal(shown.diagnostics?.outcome, 'failed');
  assert.match(shown.diagnostics!.reason!, /full-suite/);
  assert.match(record.diagnosticFailures!['full-suite']!.detail!, /runner exited/);
  assert.equal(shown.onboarding?.minutes, 6.5);
});

test(`${own} — a run that finds no failures records diagnosticsAt, catalogMs and its onboarding run, and status shows it passed`, async () => {
  const commit = 'a'.repeat(40), now = Date.parse('2026-11-24T00:00:00.000Z');
  const record = bootstrapGate(repository, commit);
  const failed = await runDiagnostics({ now: () => now, file: async () => ({ item: null }), diagnose: async sha => ({ failed: [], catalogMs: 42, onboarding: onboarded(sha) }) }, record);
  assert.deepEqual(failed, []);
  assert.equal(record.diagnosticsAt, new Date(now).toISOString());
  assert.equal(record.catalogMs, 42);
  assert.equal(record.onboarding?.minutes, 6.5);
  assert.deepEqual(gateSummary(record)!.diagnostics, { at: new Date(now).toISOString(), outcome: 'passed', reason: null });
});

test(`${own} — a run that throws records its failure reason and time, and master status names diagnostics older than 30 hours`, async () => {
  const { checkout } = await fixture('diagnostics-throw');
  const step = await batchGateStep(cycleWith(reads(checkout, { suite: () => undefined, onboarding: async () => { throw new Error('the scratch install could not start'); } })));
  await step!.diagnostics; await step!.gate;
  const record = readGateRecord(gateRecordPath(checkout))!;
  assert.equal(record.diagnosticsAt, '2026-11-18T04:14:18.630Z', 'a thrown run is retried, not counted as the day\'s run');
  const shown = gateSummary(record)!.diagnostics!;
  assert.equal(shown.outcome, 'threw');
  assert.match(shown.reason!, /the scratch install could not start/);
  assert.ok(Date.now() - Date.parse(shown.at) < 60_000);

  const [line] = diagnosticsAttention(record, Date.now());
  assert.ok(line, 'stale diagnostics raise an attention line');
  assert.match(line.text, /Daily diagnostics last completed .* ago/);
  assert.match(line.text, /threw: the scratch install could not start/);
  assert.deepEqual(diagnosticsAttention(record, Date.parse('2026-11-19T04:00:00.000Z')), [], 'within 30 hours: no line');
  assert.deepEqual(diagnosticsAttention(bootstrapGate(repository, 'b'.repeat(40)), Date.now()), [], 'never ran yet: no line');
});

test('e2e:diagnostics-record-every-run — on a running test install the scheduled diagnostics run once on the verified commit and master status shows their time and outcome', async () => {
  const { checkout, verified } = await fixture('diagnostics-e2e');
  const trials: string[] = [], cycle = cycleWith(reads(checkout, { suite: () => undefined, onboarding: async commit => onboarded(commit), trials }));
  const credentials = await temporaryDirectory('diagnostics-e2e-credentials');
  const config = { url: 'http://127.0.0.1:5', repository, credentialFile: join(credentials, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const status = () => masterStatusReport(checkout, config, async () => ({ work: [], now: new Date().toISOString() }), (command: string, args: string[]) => command === 'git' ? execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : '');

  const before = await status() as { attention: { text: string }[] };
  assert.ok(before.attention.some(line => /Daily diagnostics last completed/.test(line.text)), 'six-day-old diagnostics are named');

  const first = await batchGateStep(cycle);
  await first!.diagnostics; await first!.gate;
  assert.ok(trials.length >= 2 && trials.every(commit => commit === verified), 'the suite and catalog ran on the verified commit');
  const ran = trials.length;
  const again = await batchGateStep(cycle);
  await again!.diagnostics; await again!.gate;
  assert.equal(trials.length, ran, 'the diagnostics ran once for the day');

  const report = await status() as unknown as { attention: { text: string }[]; batchGate: { diagnosticsAt: string; diagnostics: { at: string; outcome: string }; onboarding: { minutes: number } } };
  assert.ok(Date.now() - Date.parse(report.batchGate.diagnosticsAt) < 60_000);
  assert.equal(report.batchGate.diagnostics.outcome, 'passed');
  assert.equal(report.batchGate.diagnostics.at, report.batchGate.diagnosticsAt);
  assert.equal(report.batchGate.onboarding.minutes, 6.5);
  assert.ok(!report.attention.some(line => /Daily diagnostics/.test(line.text)), 'fresh diagnostics raise no line');
});
