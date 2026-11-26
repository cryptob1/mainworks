import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runMergeTrial } from '../src/merge-writer/executor.js';
import { gateTrialKey } from '../src/merge-writer/trial-load.js';
import { runTrialAttempt } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';

// GY-3640: a commit is built once. A trial whose flaky test reruns on the same merge commit, two
// base passes that need the base tip at the same moment, and the release check on the landed commit
// together run the fixture's real build command once per distinct commit.

const proof = 'integration:one-build-per-commit';
const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const policy = { mode: 'local', mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fixture' }], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null } };
// The fixture's own commands run for real, outside the trial container (covered separately).
const run: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, wrapper: undefined,
  ...(command === 'git' ? { env: { ...process.env, ...identity, ...options?.env } } : {}) });

/** A repository whose build appends the commit it built to `builds`, and whose one test file flakes once on the change. */
async function fixture() {
  const state = await temporaryDirectory('one-build-state', tmpdir());
  const builds = join(state, 'builds.log');
  const { root, head: tip } = await gitRepo({ label: 'one-build-repo', files: {
    // The build counts its runs: each appends the commit it built, and takes long enough for a second pass to arrive.
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: `git rev-parse HEAD >> ${builds} && sleep 1`, test: 'node test.js' } }),
    'graphyard.json': JSON.stringify({ delivery: policy }),
    // The proof holds only on the head; the other case fails the first time it runs on the head, then passes.
    'test.js': `const { existsSync, writeFileSync } = require('node:fs');
const fixed = existsSync('src/fixed'), seen = ${JSON.stringify(join(state, 'ran-once'))};
const flaked = fixed && !existsSync(seen);
if (fixed) writeFileSync(seen, '');
console.log('# Subtest: tests/flaky.test.ts');
console.log('    ' + (fixed ? 'ok' : 'not ok') + ' 1 - ${proof} the fix holds');
console.log('    ' + (flaked ? 'not ok' : 'ok') + ' 2 - sometimes slow');
console.log((fixed && !flaked ? 'ok' : 'not ok') + ' 1 - tests/flaky.test.ts');
process.exit(fixed && !flaked ? 0 : 1);
`,
    'tests/flaky.test.ts': '',
  } });
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  write('src/fixed', '');
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'the change');
  const merge = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', '--detach', tip);
  const base = await temporaryDirectory('one-build-trials', tmpdir());
  return { root, builds, tip, merge, common: { root, base, caches: true, timeoutMs: 120_000, run, environment: { PATH: process.env.PATH! } } };
}

test(`${proof} — a trial with a flaky test, two concurrent base passes and the release check build each distinct commit once`, { timeout: 300_000 }, async () => {
  const { builds, tip, merge, common } = await fixture();
  const basePass = () => runTrialAttempt({ ...common, mergeSha: tip, baseTip: tip, changedFiles: ['tests/flaky.test.ts'] });
  // The trial (its flaky rerun on the merge commit, then its own base pass) beside two more base passes on the same tip.
  const [trial, ...passes] = await Promise.all([
    runMergeTrial({ ...common, mergeSha: merge, baseTip: tip, changedFiles: ['src/fixed'], proofs: [proof], e2eProofs: [], proofFiles: [], reproduce: true }),
    basePass(), basePass(),
  ]);
  assert.equal(trial.build, 'pass');
  assert.deepEqual(trial.tests.failed, [], `the flaky file passed its rerun: ${trial.logTail}`);
  assert.deepEqual(trial.flaked, { files: ['tests/flaky.test.ts'], tests: ['sometimes slow'] }, 'the rerun on the merge commit ran and named the flake');
  for (const pass of passes) assert.equal(pass.build, 'pass');
  assert.ok(passes.some(pass => /reused: an earlier pass already built this commit/.test(pass.logTail)), 'a concurrent base pass waited for the other\'s build');

  // The release check on the landed commit is given the base tip and reuses the trial's build.
  const gate = await runTrialAttempt({ ...common, key: gateTrialKey, mergeSha: merge, baseTip: tip, changedFiles: ['src/fixed'] });
  assert.equal(gate.build, 'pass');
  assert.deepEqual(gate.tests.failed, []);
  assert.match(gate.logTail, /reused: an earlier pass already built this commit/);

  assert.ok(existsSync(builds), 'the build command ran');
  assert.deepEqual(readFileSync(builds, 'utf8').trim().split('\n').sort(), [tip, merge].sort(), 'one build per distinct commit');
});

test('e2e:one-build-per-commit — a merge trial whose failing test file reruns on the same merge commit records one build step for it', { timeout: 300_000 }, async () => {
  const { builds, tip, merge, common } = await fixture();
  const steps: string[] = [];
  const trial = await runMergeTrial({ ...common, mergeSha: merge, baseTip: tip, changedFiles: ['src/fixed'], proofs: [proof], e2eProofs: [], proofFiles: [], reproduce: false,
    onStep: step => { steps.push(step); } });
  assert.deepEqual(trial.flaked, { files: ['tests/flaky.test.ts'], tests: ['sometimes slow'] }, `the failing file reran on the merge commit: ${trial.logTail}`);
  assert.deepEqual(steps.filter(step => step === 'build'), ['build'], `one build step for the merge commit: ${steps.join(', ')}`);
  assert.ok(steps.includes('build: reused'), 'the rerun reused the build');
  assert.deepEqual(readFileSync(builds, 'utf8').trim().split('\n'), [merge], 'the build command ran once');
});
