import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { defaultChildRun } from '../src/child-runner.js';
import { runTrial, slowestFile, type TrialStepReport } from '../src/merge-writer/trial.js';
import { trialTimings } from '../src/model/task-evidence.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { listen } from './helpers/http-server.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { apiOk } from './helpers/api.js';

// The item this test files carries an e2e proof, so the policy in force says how a head is served for
// it; the policy is read once per process, and nothing reads it ahead of this line.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3599: the Task page's evidence, from a real control plane on isolated Postgres with a git fixture:
// the trial's step timings and slowest file from the merge ledger, the changed files and one file's
// diff from the checkout, and the model the Builder's session reported beside its account's.
const minute = 60_000, slow = 'tests/remote-shards.test.ts';

test('e2e:task-shows-evidence — the control plane serves a task\'s trial timings, changed files, file diff and reported model', async () => {
  const { root: repo, head: baseTip, git } = await gitRepo({ label: 'task-evidence-repo', files: { 'shards.ts': 'export const usable = 1;\nexport const kept = 2;\n' } });
  mkdirSync(join(repo, 'tests'));
  git('checkout', '-q', '-b', 'graphyard/gy-1-1');
  writeFileSync(join(repo, 'shards.ts'), 'export const usable = 3;\nexport const kept = 2;\n');
  writeFileSync(join(repo, slow), 'test one\ntest two\n');
  // A name git would quote, and that read as a pattern would match no file.
  writeFileSync(join(repo, 'tests/hot[1].test.ts'), 'test hot\n');
  git('add', '-A'); git('commit', '-q', '-m', 'change');
  const head = git('rev-parse', 'HEAD'), mergeSha = 'c'.repeat(40);

  const store: Store = await withDatabase('task-shows-evidence'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = gitRunnerFor(repo); engine.baseBranch = 'main';
  // The install's checkout: the root the control plane reads heads from.
  const rootBefore = process.env.GRAPHYARD_REPOSITORY_ROOT; process.env.GRAPHYARD_REPOSITORY_ROOT = repo;
  const { url, close } = await listen(server(engine, [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: 'operator' }, { id: 'claude-builder-7', role: 'worker', token: 'builder' },
    { id: 'graphyard-merge-writer', role: 'coordinator', token: 'coordinator' }] as never));
  let calls = 0;
  const call = (token: string, path: string, body?: unknown) => apiOk(url, token, path, { body, key: `evidence-${++calls}` });
  try {
    const filed = await call('operator', 'work', { title: 'Trials keep their shards when hot', why: 'Trials were slow.', simplest: 'Keep the local host.', type: 'feature', priority: 2, criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['e2e:sign-in'] }] });
    const item = `work/${filed.id}`;
    // The install's checkout the control plane reads this head from, for the command that checks the branch out.
    assert.deepEqual(await call('operator', `${item}/timings`), { releasedAt: null, trial: null, checkout: repo });
    assert.deepEqual(await call('operator', `${item}/diff`), { files: [] });
    await call('operator', `${item}/ready`, {});
    const claimed = await call('builder', `${item}/claim`, {});
    await call('builder', `${item}/workspace`, { epoch: claimed.epoch, host: 'machine-a', path: repo, branch: 'graphyard/gy-1-1' });
    await call('builder', `${item}/submit`, { epoch: claimed.epoch, head });

    // The changed files with their counts, and one file's diff, from the control plane's checkout.
    assert.deepEqual((await call('operator', `${item}/diff`)).files, [{ path: 'shards.ts', additions: 1, deletions: 1 }, { path: 'tests/hot[1].test.ts', additions: 1, deletions: 0 }, { path: slow, additions: 2, deletions: 0 }]);
    const { diff } = await call('operator', `${item}/diff?path=shards.ts`);
    assert.match(diff, /^@@ /);
    assert.match(diff, /^-export const usable = 1;\n\+export const usable = 3;$/m);
    assert.doesNotMatch(diff, /test one/);
    assert.match((await call('operator', `${item}/diff?path=${encodeURIComponent('tests/hot[1].test.ts')}`)).diff, /^\+test hot$/m, "a name that reads as a pattern is still found");

    // A trial of 19 minutes whose tests step took 17, one file 14 of them: its steps in flight, then its verdict.
    const started = Date.now() - 19 * minute, at = (minutes: number) => new Date(started + minutes * minute).toISOString();
    const record = (body: object) => call('coordinator', `${item}/merge-record`, body);
    await record({ kind: 'intent', head, baseTip, mergeSha, risk: 'normal', at: at(0) });
    await record({ kind: 'trial-step', head, step: 'checkout', at: at(0) });
    await record({ kind: 'trial-step', head, step: 'build', at: at(1) });
    await record({ kind: 'trial-step', head, step: 'tests', at: at(2) });
    assert.equal((await call('operator', `${item}/timings`)).trial.output, null, 'no output before a group of tests ends');
    // A shard that ended sends the same step again under its own start, with its output and the counts so far: still one step, both shown while it runs.
    await record({ kind: 'trial-step', head, step: 'tests', at: at(2), output: `$ node --test (shard 1)\nnot ok 1 - ${slow}\n  a CPU sensor reads 96C`, tests: { passed: 11, failed: 1, files: 40, slowest: { file: slow, durationMs: 14 * minute } } });
    // A later passing shard omits output so reports stay small; the running/failing output stays visible instead of wiping to null.
    await record({ kind: 'trial-step', head, step: 'tests', at: at(2), tests: { passed: 21, failed: 1, files: 40, slowest: { file: slow, durationMs: 14 * minute } } });
    const running = (await call('operator', `${item}/timings`)).trial;
    assert.equal(running.finishedAt, null);
    assert.match(running.output, /not ok 1 - tests\/remote-shards\.test\.ts\n  a CPU sensor reads 96C$/);
    assert.deepEqual(running.steps.map((step: any) => [step.step, step.result]), [['checkout', 'passed'], ['build', 'passed'], ['tests', 'running']]);
    assert.equal(running.steps[0].durationMs, minute);
    assert.ok(running.steps[2].durationMs >= 17 * minute && running.steps[2].durationMs < 18 * minute);
    assert.deepEqual([running.groups, running.slowest, running.soFar], [[{ name: 'tests', passed: 21, failed: 1, total: 40 }], { file: slow, durationMs: 14 * minute }, true]);

    const slowest = slowestFile(`${JSON.stringify({ file: 'tests/quick.test.ts', durationMs: 900 })}\nnot a record\n${JSON.stringify({ file: slow, durationMs: 14 * minute })}`);
    assert.deepEqual(slowest, { file: slow, durationMs: 14 * minute });
    await record({ kind: 'trial', head, baseTip, mergeSha, outcome: 'verdict', build: 'pass', tests: { passed: 39, failed: [slow], files: 40, slowest }, files: ['shards.ts', slow],
      proofs: {}, durationMs: 19 * minute, attempts: [], e2e: [{ proof: 'e2e:a', case: 'a', executed: 1, failed: 0 }, { proof: 'e2e:b', case: 'b', executed: 1, failed: 0 }] });
    const timings = await call('operator', `${item}/timings`), trial = timings.trial;
    assert.ok(Date.parse(timings.releasedAt) <= Date.now());
    assert.equal(trial.head, head);
    assert.ok(trial.finishedAt);
    assert.equal(trial.output, null, 'a finished trial answers with its verdict, not its running output');
    assert.deepEqual(trial.steps.map((step: any) => [step.step, step.result]), [['checkout', 'passed'], ['build', 'passed'], ['tests', 'failed']]);
    assert.ok(Math.abs(trial.durationMs - 19 * minute) < 5000);
    assert.deepEqual(trial.groups, [{ name: 'tests', passed: 39, failed: 1, total: 40 }, { name: 'e2e', passed: 2, failed: 0, total: 2 }]);
    assert.deepEqual(trial.slowest, { file: slow, durationMs: 14 * minute });
    assert.equal(trial.soFar, false, 'a verdict\'s counts are final');

    // A trial that ended with no verdict keeps the counts of the shards that ended: they are not its failure's counts.
    const head40 = 'd'.repeat(40);
    const ended = trialTimings([
      { kind: 'merge.intent', payload: { head: head40, at: at(0) }, created_at: at(0) },
      { kind: 'merge.trial-step', payload: { head: head40, step: 'tests', at: at(2) }, created_at: at(2) },
      { kind: 'merge.trial-step', payload: { head: head40, step: 'tests', at: at(2), tests: { passed: 30, failed: 0, files: 40, slowest } }, created_at: at(10) },
      { kind: 'merge.trial', payload: { head: head40, outcome: 'timeout', phase: 'tests' }, created_at: at(19) },
    ], Date.now());
    assert.deepEqual([ended!.groups, ended!.slowest, ended!.soFar], [[{ name: 'tests', passed: 30, failed: 0, total: 40 }], { file: slow, durationMs: 14 * minute }, true]);

    // The model the Builder's session reported, marked when the account's own is another.
    const launch = { kind: 'claude', args: [], environment: {}, homeVariable: null, modelFlag: '--model', login: null, loginFile: null };
    await call('operator', 'agent-registry/apply', { runtimes: [{ name: 'claude', launch }], models: [{ name: 'sonnet', id: 'claude-sonnet-5-5', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'frontier', contextTokens: null } }],
      accounts: [{ name: 'claude-a', runtime: 'claude', model: 'sonnet', credential: { host: 'machine-a', home: '/agents/claude-a' } }], roles: [], reason: 'fixture' });
    const usage = (id: string, model: string, minutesAgo: number) => ({ id, work: filed.key, role: 'worker', account: 'claude-a', runtime: 'claude', model, reported: true, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, at: new Date(Date.now() - minutesAgo * minute).toISOString() });
    await call('coordinator', 'usage', { rows: [usage('run-1', 'claude-sonnet-5-5-20261001', 30)] });
    assert.deepEqual((await call('operator', `costs?work=${filed.key}`)).builder, { account: 'claude-a', model: 'claude-sonnet-5-5-20261001', accountModel: 'claude-sonnet-5-5', differs: false });
    await call('coordinator', 'usage', { rows: [usage('run-2', 'claude-opus-5-5', 5)] });
    assert.deepEqual((await call('operator', `costs?work=${filed.key}`)).builder, { account: 'claude-a', model: 'claude-opus-5-5', accountModel: 'claude-sonnet-5-5', differs: true });
    assert.equal('builder' in await call('operator', 'costs'), false);
  } finally { await close(); await store.close(); if (rootBefore === undefined) delete process.env.GRAPHYARD_REPOSITORY_ROOT; else process.env.GRAPHYARD_REPOSITORY_ROOT = rootBefore; }
});

test('e2e:task-shows-evidence — each test shard\'s end reports the trial\'s counts so far and its slowest file so far', async () => {
  const repo = await temporaryDirectory('task-evidence-trial'), scratch = await temporaryDirectory('task-evidence-scratch');
  mkdirSync(join(repo, 'tests'));
  const { head: mergeSha } = await gitRepo({ root: repo, message: 'fixture', files: {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'node -e ""' } }), 'scripts/ci-tests.mjs': '// fixture selection\n',
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { preMerge: [{ check: 'test', command: 'node tests/helpers/run-tests.ts', source: 'script', reason: 'fixture',
      selection: { command: 'node scripts/ci-tests.mjs affected', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }], perCandidate: [] } } }) } });
  // The selector names two files, each its own shard. Each shard's runner writes its records: one file fails, the other is slow.
  const quick = 'tests/b.test.ts';
  const run = (async (command: string, args: string[], options: never) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/ci-tests.mjs') return `${slow}\n${quick}\n`;
    if (command === 'node' && args.includes('--durations')) {
      const files = readFileSync(args[args.indexOf('--files-from') + 1]!, 'utf8').split('\n').filter(Boolean);
      writeFileSync(args[args.indexOf('--durations') + 1]!, `${files.map(file => JSON.stringify({ file, passed: file !== quick, durationMs: file === slow ? 14 * minute : 900 })).join('\n')}\n`);
      return 'Authorization: Bearer super-secret-shard-token\n';
    }
    return defaultChildRun(command, args, options);
  }) as never;
  const reports: [string, TrialStepReport | undefined][] = [];
  const verdict = await runTrial({ root: repo, base: scratch, mergeSha, changedFiles: ['scripts/ci-tests.mjs'], timeoutMs: 120_000, run, groupSize: 1, cores: 2, retries: 0,
    environment: { PATH: process.env.PATH! }, temporaryRoots: [scratch], checkoutRoots: [scratch], onStep: (step, report) => reports.push([step, report]) });
  const counts = reports.flatMap(([, report]) => report?.tests ? [report.tests] : []);
  assert.equal(counts.length, 2, 'each of the two shards reports its end');
  assert.equal(counts[0]!.passed + counts[0]!.failed, 1, 'the first report counts the one shard that has ended');
  assert.deepEqual(counts[1], { passed: 1, failed: 1, files: 2, slowest: { file: slow, durationMs: 14 * minute } });
  const outputs = reports.flatMap(([, report]) => report?.output ? [report.output] : []);
  assert.ok(outputs.length >= 1, 'a shard\'s end still sends what it printed');
  for (const output of outputs) {
    assert.doesNotMatch(output, /super-secret-shard-token/, 'shard output masks credentials before leaving the trial');
    assert.match(output, /\[redacted\]/);
  }
  assert.deepEqual([verdict.tests, verdict.slowest], [{ passed: 1, failed: [quick], files: 2 }, { file: slow, durationMs: 14 * minute }]);
});
