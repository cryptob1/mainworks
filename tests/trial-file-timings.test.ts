import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { gateTrialKey } from '../src/merge-writer/trial-load.js';
import { readTrialTimings } from '../src/merge-writer/trial-timings.js';
import { slowestTrialTestFiles, plannerPrompt } from '../src/daemon/planner.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';

const identity = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const writeFiles = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
const testFiles = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(name => `tests/${name}.test.ts`);

/** A repository whose test runner reports each file's duration from durations.json; answers a commit per durations map. */
async function fixtureRepo() {
  const root = await temporaryDirectory('trial-timings-repo');
  const base = await temporaryDirectory('trial-timings-base');
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, '.graphyard'));
  writeFiles(root, {
    '.gitignore': 'node_modules\n.graphyard\n',
    'package.json': JSON.stringify({ name: 'timings-fixture', scripts: { build: 'node -e ""' } }),
    'package-lock.json': '{"lockfileVersion":3}\n',
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{
      check: 'test', command: 'node scripts/run-tests.mjs', source: 'script', reason: 'fixture',
      selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' },
    }] } } }),
    'scripts/select.mjs': 'console.log("tests/alpha.test.ts");\n',
    'scripts/run-tests.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
const files = readFileSync(process.argv[process.argv.indexOf('--files-from') + 1], 'utf8').split('\\n').filter(Boolean);
const durations = JSON.parse(readFileSync('durations.json', 'utf8'));
const results = files.map(file => ({ file, durationMs: durations[file] ?? 50, passed: true }));
for (const r of results) console.log('ok - ' + r.file);
writeFileSync(process.argv[process.argv.indexOf('--durations') + 1], results.map(r => JSON.stringify(r)).join('\\n') + '\\n');
`,
    ...Object.fromEntries(testFiles.map(file => [file, '// fixture\n'])),
  });
  const commit = (durations: Record<string, number>) => {
    writeFileSync(join(root, 'durations.json'), JSON.stringify(durations));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'durations');
    return git(root, 'rev-parse', 'HEAD');
  };
  return { root, base, commit };
}

const directRunner = (): ChildRun => async (command, args, { wrapper: _wrapper, ...options } = {}) => {
  if (command === 'npm' && args[0] === 'ci') { mkdirSync(join(options.cwd!, 'node_modules'), { recursive: true }); return 'added 0 packages'; }
  return defaultChildRun(command, args, options);
};

const trial = (repo: { root: string; base: string }, mergeSha: string, key: string) => runTrial({
  root: repo.root, base: repo.base, mergeSha, changedFiles: testFiles, timeoutMs: 120_000, key,
  caches: false, retries: 0, run: directRunner(), selectFiles: async () => testFiles, remote: { hosts: [] },
});

async function statusOf(root: string) {
  const credentials = await temporaryDirectory('trial-timings-creds');
  const config = masterConfigSchema.parse({
    version: 1, url: 'http://127.0.0.1:9', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/timings', baseBranch: 'main', githubAppId: 1234, hostId: 'timings-host', masterAgentName: 'graphyard-master-timings', workers: [],
  });
  await writeFile(daemonStatePath(config), JSON.stringify(emptyDaemonState(config)));
  const run = async (command: string, args: string[]) =>
    isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`;
  return masterStatusReport(root, config, async path => {
    if (path === 'work-snapshot') return { work: [], now: new Date().toISOString() };
    throw Object.assign(new Error('absent'), { status: 404 });
  }, run);
}

test('integration:trial-file-timings — a merge trial and a release check store each file\'s duration; master status and the planner name the five slowest by median', { timeout: 180_000 }, async () => {
  const repo = await fixtureRepo();
  const first = repo.commit({ 'tests/alpha.test.ts': 1000, 'tests/beta.test.ts': 4000, 'tests/gamma.test.ts': 200, 'tests/delta.test.ts': 9000, 'tests/epsilon.test.ts': 3000, 'tests/zeta.test.ts': 6000 });
  const second = repo.commit({ 'tests/alpha.test.ts': 3000, 'tests/beta.test.ts': 2000, 'tests/gamma.test.ts': 400, 'tests/delta.test.ts': 7000, 'tests/epsilon.test.ts': 5000, 'tests/zeta.test.ts': 2000 });

  await trial(repo, first, 'GY-1');
  await trial(repo, second, gateTrialKey);

  const stored = readTrialTimings(repo.root);
  assert.equal(stored.length, 2, 'each trial stores one timing record');
  assert.deepEqual(stored.map(run => [run.run, run.commit]), [['merge trial', first], ['release check', second]]);
  assert.equal(stored[0]!.files['tests/delta.test.ts'], 9000);
  assert.equal(stored[1]!.files['tests/gamma.test.ts'], 400);
  assert.equal(Object.keys(stored[1]!.files).length, testFiles.length, 'every test file the trial ran has its duration');

  const expected = [
    { file: 'tests/delta.test.ts', medianSeconds: 8 },
    { file: 'tests/epsilon.test.ts', medianSeconds: 4 },
    { file: 'tests/zeta.test.ts', medianSeconds: 4 },
    { file: 'tests/beta.test.ts', medianSeconds: 3 },
    { file: 'tests/alpha.test.ts', medianSeconds: 2 },
  ];
  const report = await statusOf(repo.root);
  assert.deepEqual(report.slowestTrialFiles, { trials: 2, files: expected });

  // The planner reads the stored timings, not the checked-in baseline.
  const slowest = slowestTrialTestFiles(repo.root);
  assert.deepEqual(slowest, expected.map(entry => ({ file: entry.file, seconds: entry.medianSeconds })));
  const prompt = plannerPrompt({ brief: null, flow6h: null, slowestTrialFiles: slowest, openTitles: [] });
  assert.match(prompt, /1\. tests\/delta\.test\.ts \(8s\)/);
});

test('e2e:trial-file-timings — on a test install master status shows the slowest trial files after one trial', { timeout: 120_000 }, async () => {
  const repo = await fixtureRepo();
  const sha = repo.commit({ 'tests/alpha.test.ts': 1200, 'tests/beta.test.ts': 4500, 'tests/gamma.test.ts': 900, 'tests/delta.test.ts': 8100, 'tests/epsilon.test.ts': 3000, 'tests/zeta.test.ts': 6200 });
  assert.equal((await statusOf(repo.root)).slowestTrialFiles, null, 'no trial yet, no slowest files');

  await trial(repo, sha, 'GY-2');

  const report = await statusOf(repo.root);
  assert.deepEqual(report.slowestTrialFiles, { trials: 1, files: [
    { file: 'tests/delta.test.ts', medianSeconds: 8.1 },
    { file: 'tests/zeta.test.ts', medianSeconds: 6.2 },
    { file: 'tests/beta.test.ts', medianSeconds: 4.5 },
    { file: 'tests/epsilon.test.ts', medianSeconds: 3 },
    { file: 'tests/alpha.test.ts', medianSeconds: 1.2 },
  ] });
});
