// GY-3747: the daily diagnostics time a fresh repository from connect to first merged change in a
// scratch install, master status shows the last run's minutes, result and date, and a run over 15
// minutes or needing a hand fix files an item.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapGate, gateRecordPath, gateSummary, readGateRecord, runDiagnostics, writeGateRecord, type GateRecord } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import { defaultChildRun } from '../src/child-runner.js';
import { measureOnboarding, onboardingCase, runOnboardingTime, type OnboardingRun } from '../src/onboarding-time.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const own = 'integration:onboarding-time-measured';
const commit = 'a'.repeat(40), at = '2026-11-23T00:00:00.000Z';
const run = (minutes: number, handFixes: string[] = []): OnboardingRun => ({ at, commit, minutes, result: handFixes.length ? 'failed' : 'passed', handFixes });

const diagnosed = async (onboarding: OnboardingRun, record: GateRecord = bootstrapGate('o/r', commit)) => {
  const filed: { key: string; description: string }[] = [];
  const failed = await runDiagnostics({ now: () => Date.parse(at), file: async input => { filed.push(input); return { item: 'GY-9' }; },
    diagnose: async () => ({ failed: [], catalogMs: 1, onboarding }) }, record);
  return { record, failed, filed };
};

test(`${own} — a scratch install connects a fixture repository, starts its first task from first run and records the minutes to its first merge`, async () => {
  const store = await withDatabase('onboarding_time');
  await store.init();
  try {
    const measured = await measureOnboarding(store, { scratch: await temporaryDirectory('onboarding-time'), commit });
    assert.equal(measured.result, 'passed', JSON.stringify(measured));
    assert.deepEqual(measured.handFixes, []);
    assert.ok(measured.minutes >= 0 && measured.minutes < 15, `minutes ${measured.minutes}`);
    const [task] = await store.list();
    assert.equal(task!.stage, 'done', 'the first task merged');
    assert.ok(task!.delivery?.mergedAt);
  } finally { await store.close(); }
});

test(`${own} — master status shows the last run's minutes, result and date; a run over 15 minutes or needing a hand fix files an item`, async () => {
  const quick = await diagnosed(run(4.2));
  assert.deepEqual(quick.filed, []);
  assert.deepEqual(gateSummary(quick.record)!.onboarding, { minutes: 4.2, result: 'passed', at, commit: commit.slice(0, 12), handFixes: [] });

  const slow = await diagnosed(run(16.5));
  assert.deepEqual(slow.filed.map(entry => entry.key), ['diagnostic:onboarding:first-merge']);
  assert.match(slow.filed[0]!.description, /16\.5 minutes/);
  assert.equal(gateSummary(slow.record)!.onboarding!.result, 'passed');

  const fixed = await diagnosed(run(3, ['start the first task: The task was refused']));
  assert.deepEqual(fixed.filed.map(entry => entry.key), ['diagnostic:onboarding:first-merge']);
  assert.match(fixed.filed[0]!.description, /start the first task: The task was refused/);
  assert.deepEqual(gateSummary(fixed.record)!.onboarding!.handFixes, ['start the first task: The task was refused']);
});

test(`${own} — the daily diagnostics of a repository holding the case run it on the verified commit; a catalog without it runs none`, async () => {
  const asked: string[] = [];
  const reads = (held: string[]) => ({ now: () => Date.parse(at), fetch: async () => commit, baseBranch: 'main', trial: async () => ({ build: 'pass', tests: { failed: [] }, e2e: [] }),
    git: async (args: string[]) => args[0] === 'ls-tree' ? held.map(id => `${id}.json`).join('\n') : '',
    gate: { root: '/repo', repository: 'o/r', onboarding: async (sha: string) => { asked.push(sha); return run(2); } } });
  assert.equal((await batchGatePorts(reads([onboardingCase, 'smoke']) as never, []).diagnose(commit)).onboarding?.minutes, 2);
  assert.deepEqual(asked, [commit]);
  assert.equal((await batchGatePorts(reads(['smoke']) as never, []).diagnose(commit)).onboarding, undefined);
  assert.deepEqual(asked, [commit], 'a repository without the case runs none');
});

test(`${own} — the host run checks the commit out and reads its scratch install's result; a commit without the measurement is a failed run naming why`, async () => {
  const root = await temporaryDirectory('onboarding-time-repo');
  const git = (...args: string[]) => defaultChildRun('git', ['-C', root, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'README.md'), '# bare\n');
  await git('add', '.'); await git('commit', '-q', '-m', 'bare');
  const bare = (await git('rev-parse', 'HEAD')).trim();
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'onboarding-time.ts'), `console.log('noise');\nconsole.log(JSON.stringify({ at: '${at}', commit: process.argv[2], minutes: 1.5, result: 'passed', handFixes: [] }));\n`);
  await git('add', '.'); await git('commit', '-q', '-m', 'measured');
  const measured = (await git('rev-parse', 'HEAD')).trim();
  assert.deepEqual(await runOnboardingTime({ root, commit: measured }), { at, commit: measured, minutes: 1.5, result: 'passed', handFixes: [] });
  const missing = await runOnboardingTime({ root, commit: bare });
  assert.equal(missing.result, 'failed');
  assert.equal(missing.handFixes.length, 1);
});

test(`${own} — the gate record keeps the run, so master status reads it from disk`, async () => {
  const root = await temporaryDirectory('onboarding-time-record');
  const { record } = await diagnosed(run(7.3));
  await mkdir(join(root, '.graphyard'), { recursive: true });
  writeGateRecord(gateRecordPath(root), record);
  assert.equal(gateSummary(readGateRecord(gateRecordPath(root)))!.onboarding!.minutes, 7.3);
});
