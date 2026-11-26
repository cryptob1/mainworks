import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import {
  appendBenchResult,
  benchDue,
  benchIntervalMs,
  benchResultsLimit,
  benchResultsPath,
  benchStatus,
  benchTrial,
  compareBenchResults,
  formatBenchComparison,
  readBenchResults,
  type BenchResult,
} from '../src/bench.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { guideText } from '../src/guide.js';

async function fixtureRepo() {
  const base = await temporaryDirectory('bench-trial-base');
  const files: Record<string, string> = {
    '.gitignore': 'node_modules\n',
    'package.json': JSON.stringify({ name: 'bench-fixture', scripts: { build: 'node -e ""' } }),
    'package-lock.json': '{"lockfileVersion":3}\n',
    'graphyard.json': JSON.stringify({
      delivery: {
        mergeGate: {
          perCandidate: [],
          preMerge: [{
            check: 'test',
            command: 'node scripts/run-tests.mjs',
            source: 'script',
            reason: 'fixture',
            selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' },
          }],
        },
      },
    }),
    'bench/trial-files.txt': [
      'tests/alpha.test.ts',
      'tests/beta.test.ts',
      'tests/gamma.test.ts',
      'tests/delta.test.ts',
      'tests/epsilon.test.ts',
      'tests/zeta.test.ts',
    ].join('\n') + '\n',
    'scripts/select.mjs': 'console.log("tests/alpha.test.ts");\n',
    'scripts/run-tests.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
const files = readFileSync(process.argv[process.argv.indexOf('--files-from') + 1], 'utf8').split('\\n').filter(Boolean);
const durations = { 'tests/alpha.test.ts': 120, 'tests/beta.test.ts': 450, 'tests/gamma.test.ts': 90, 'tests/delta.test.ts': 810, 'tests/epsilon.test.ts': 300, 'tests/zeta.test.ts': 620 };
const results = files.map(file => ({ file, durationMs: durations[file] ?? 50, passed: true }));
for (const r of results) console.log('ok - ' + r.file);
writeFileSync(process.argv[process.argv.indexOf('--durations') + 1], results.map(r => JSON.stringify(r)).join('\\n') + '\\n');
`,
    'tests/alpha.test.ts': '// alpha\n',
    'tests/beta.test.ts': '// beta\n',
    'tests/gamma.test.ts': '// gamma\n',
    'tests/delta.test.ts': '// delta\n',
    'tests/epsilon.test.ts': '// epsilon\n',
    'tests/zeta.test.ts': '// zeta\n',
  };
  const { root, head: tip } = await gitRepo({ label: 'bench-trial-repo', files, message: 'initial fixture' });
  return { root, base, tip };
}

function directRunner(): ChildRun {
  return async (command, args, { wrapper: _wrapper, ...options } = {}) => {
    if (command === 'npm' && args[0] === 'ci') {
      mkdirSync(join(options.cwd!, 'node_modules'), { recursive: true });
      return 'added 0 packages';
    }
    return defaultChildRun(command, args, options);
  };
}

function sampleResult(overrides: Partial<BenchResult> = {}): BenchResult {
  return {
    at: '2026-11-22T00:00:00.000Z',
    commit: 'a'.repeat(40),
    build: 'b'.repeat(40),
    fileList: 'bench/trial-files.txt',
    fileListHash: '0123456789abcdef',
    files: 200,
    outcome: 'pass',
    wallSeconds: 100,
    cpuSeconds: 200,
    steps: {
      checkout: 5,
      build: 15,
      selection: 2,
      'tests: shard 1': 60,
      'tests: shard 2': 18,
      e2e: 0,
      browser: 0,
    },
    shardsPerHost: { localhost: 2 },
    slowestFiles: [
      { file: 'tests/a.test.ts', seconds: 12 },
      { file: 'tests/b.test.ts', seconds: 10 },
      { file: 'tests/c.test.ts', seconds: 8 },
      { file: 'tests/d.test.ts', seconds: 6 },
      { file: 'tests/e.test.ts', seconds: 4 },
    ],
    hostTemperatures: { localhost: 55 },
    ...overrides,
  };
}

test('integration:bench-trial-reports — runs reference trial on fixture repo, reports all fields, and stored result matches printed result', { timeout: 120_000 }, async () => {
  const repo = await fixtureRepo();
  const resultsFile = benchResultsPath(repo.root);
  let printed = '';

  // Also verify checked-in bench/trial-files.txt exists in Mainworks repo with ~200 files.
  const checkedInPath = join(import.meta.dirname, '..', 'bench', 'trial-files.txt');
  assert.ok(existsSync(checkedInPath), 'bench/trial-files.txt must be checked in');
  const checkedInFiles = readFileSync(checkedInPath, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.ok(checkedInFiles.length >= 180 && checkedInFiles.length <= 220, `expected ~200 files in bench/trial-files.txt, got ${checkedInFiles.length}`);

  const result = await benchTrial({
    root: repo.root,
    base: repo.base,
    resultsFile,
    build: '1'.repeat(40),
    run: directRunner(),
    remote: { hosts: [] },
    print: line => { printed += line; },
  });

  // Verify printed JSON matches returned and stored result.
  const parsedPrinted = JSON.parse(printed) as BenchResult;
  assert.deepEqual(parsedPrinted, result);

  const stored = readBenchResults(resultsFile);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], parsedPrinted);

  // Assert every required field is present and valid.
  assert.equal(result.commit, repo.tip);
  assert.equal(result.build, '1'.repeat(40));
  assert.equal(result.outcome, 'pass');
  assert.equal(result.files, 6);
  assert.equal(typeof result.wallSeconds, 'number');
  assert.ok(result.wallSeconds >= 0);
  assert.equal(typeof result.cpuSeconds, 'number');
  assert.ok(result.cpuSeconds >= 0);
  assert.equal(typeof result.steps.checkout, 'number');
  assert.equal(typeof result.steps.build, 'number');
  assert.equal(typeof result.steps.selection, 'number');
  assert.equal(typeof result.steps.e2e, 'number');
  assert.equal(typeof result.steps.browser, 'number');
  assert.ok(Object.keys(result.steps).some(k => k.startsWith('tests: shard ')), 'steps must include each test group');
  assert.ok(Object.keys(result.shardsPerHost).length >= 1, 'shardsPerHost must have at least one host');
  assert.equal(result.slowestFiles.length, 5, 'slowestFiles must contain the slowest five files');
  assert.equal(result.slowestFiles[0]!.file, 'tests/delta.test.ts');
  assert.equal(result.slowestFiles[1]!.file, 'tests/zeta.test.ts');
  assert.ok(Object.keys(result.hostTemperatures).length >= 1, 'hostTemperatures must record each host at start');

  // Assert results file caps at 200 entries.
  for (let i = 0; i < benchResultsLimit + 5; i++) {
    await appendBenchResult(resultsFile, sampleResult({ at: new Date(Date.UTC(2026, 10, 22, 0, i)).toISOString(), wallSeconds: i }));
  }
  const capped = readBenchResults(resultsFile);
  assert.equal(capped.length, benchResultsLimit);
  assert.equal(capped.at(-1)!.wallSeconds, benchResultsLimit + 4);
});

test('unit:bench-schedule-and-comparison — schedule runs once per new build and every 6h when idle; comparison computes median and attention line', () => {
  const t0 = Date.parse('2026-11-22T00:00:00.000Z');
  const buildA = 'a'.repeat(40);
  const buildB = 'b'.repeat(40);

  // Never runs when a trial is queued or already in flight.
  assert.equal(benchDue({ results: [], currentBuild: buildA, now: t0, trialQueued: true, inFlight: false }).due, false);
  assert.equal(benchDue({ results: [], currentBuild: buildA, now: t0, trialQueued: false, inFlight: true }).due, false);

  // Runs when no results yet and idle.
  assert.equal(benchDue({ results: [], currentBuild: buildA, now: t0, trialQueued: false, inFlight: false }).due, true);

  // After running on buildA, does not run again 1 hour later on the same build.
  const first = sampleResult({ at: new Date(t0).toISOString(), build: buildA });
  assert.equal(benchDue({ results: [first], currentBuild: buildA, now: t0 + 3_600_000, trialQueued: false, inFlight: false }).due, false);

  // Runs immediately when a new build deploys (buildB !== buildA), if no trial is queued.
  assert.equal(benchDue({ results: [first], currentBuild: buildB, now: t0 + 60_000, trialQueued: false, inFlight: false }).due, true);
  assert.equal(benchDue({ results: [first], currentBuild: buildB, now: t0 + 60_000, trialQueued: true, inFlight: false }).due, false);

  // Runs again after 6 hours on the same build.
  assert.equal(benchDue({ results: [first], currentBuild: buildA, now: t0 + benchIntervalMs, trialQueued: false, inFlight: false }).due, true);

  // Comparison: previous 10 on the same file list (ignoring results on a different file list).
  const differentList = sampleResult({ fileListHash: 'ffffffffffffffff', wallSeconds: 999, cpuSeconds: 999 });
  const baseline10 = Array.from({ length: 10 }, (_, i) => sampleResult({
    at: new Date(t0 + i * 3_600_000).toISOString(),
    wallSeconds: 100,
    cpuSeconds: 200,
    steps: { checkout: 5, build: 15, selection: 2, 'tests: shard 1': 60, 'tests: shard 2': 18, e2e: 0, browser: 0 },
  }));

  // +20% (not > 25%): no attention line.
  const withinBound = benchStatus([differentList, ...baseline10, sampleResult({ wallSeconds: 120, cpuSeconds: 220 })]);
  assert.ok(withinBound);
  assert.equal(withinBound.median?.count, 10);
  assert.equal(withinBound.median?.wallSeconds, 100);
  assert.equal(withinBound.median?.cpuSeconds, 200);
  assert.equal(withinBound.wallChangePercent, 20);
  assert.equal(withinBound.cpuChangePercent, 10);
  assert.equal(withinBound.attention, null);

  // +40% (> 25%): one attention line naming the step that grew most.
  const regressed = benchStatus([
    differentList,
    ...baseline10,
    sampleResult({
      wallSeconds: 140,
      cpuSeconds: 260,
      steps: { checkout: 6, build: 45, selection: 2, 'tests: shard 1': 69, 'tests: shard 2': 18, e2e: 0, browser: 0 },
    }),
  ]);
  assert.ok(regressed);
  assert.equal(regressed.wallChangePercent, 40);
  assert.equal(regressed.cpuChangePercent, 30);
  assert.ok(regressed.attention, 'expected an attention line when wall time is > 25% above median');
  assert.match(regressed.attention.text, /40%/);
  assert.match(regressed.attention.text, /\bbuild\b/);
});

test('e2e:bench-shown-in-status — seeds eleven results with the last 40% slower and asserts change and attention line appear in master status', async () => {
  const root = await temporaryDirectory('bench-status-root');
  const credentials = await temporaryDirectory('bench-status-creds');
  execFileSync('git', ['init', '-q', root]);

  const resultsFile = benchResultsPath(root);
  const t0 = Date.parse('2026-11-22T00:00:00.000Z');
  for (let i = 0; i < 10; i++) {
    await appendBenchResult(resultsFile, sampleResult({
      at: new Date(t0 + i * 3_600_000).toISOString(),
      wallSeconds: 100,
      cpuSeconds: 200,
      steps: { checkout: 5, build: 15, selection: 2, 'tests: shard 1': 60, 'tests: shard 2': 18, e2e: 0, browser: 0 },
    }));
  }
  await appendBenchResult(resultsFile, sampleResult({
    at: new Date(t0 + 10 * 3_600_000).toISOString(),
    wallSeconds: 140,
    cpuSeconds: 250,
    steps: { checkout: 5, build: 15, selection: 2, 'tests: shard 1': 100, 'tests: shard 2': 18, e2e: 0, browser: 0 },
  }));

  const config = masterConfigSchema.parse({
    version: 1,
    url: 'http://127.0.0.1:9',
    credentialFile: join(credentials, 'coordinator.token'),
    cliPath: '/bin/graphyard',
    repository: 'owner/bench',
    baseBranch: 'main',
    githubAppId: 1234,
    hostId: 'bench-host',
    masterAgentName: 'graphyard-master-bench',
    workers: [],
  });
  await writeFile(daemonStatePath(config), JSON.stringify(emptyDaemonState(config)));
  const snapshot = { work: [], now: new Date(t0 + 11 * 3_600_000).toISOString() };
  const run = async (command: string, args: string[]) =>
    isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`;

  const report = await masterStatusReport(root, config, async path => {
    if (path === 'work-snapshot') return snapshot;
    throw Object.assign(new Error('absent'), { status: 404 });
  }, run);

  assert.ok(report.bench, 'master status must include bench summary');
  assert.equal(report.bench.latest.wallSeconds, 140);
  assert.equal(report.bench.median?.wallSeconds, 100);
  assert.equal(report.bench.wallChangePercent, 40);
  assert.equal(report.bench.cpuChangePercent, 25);
  const line = report.attention.find(entry => entry.subject === 'bench trial');
  assert.ok(line, 'master status attention must include a bench trial regression line');
  assert.match(line.text, /40%/);
  assert.match(line.text, /tests: shard 1/);
});

test('unit:bench-compare — compares two stored results per step and worker proof guide documents quoting it', () => {
  const mainResult = sampleResult({
    commit: '1'.repeat(40),
    wallSeconds: 120,
    cpuSeconds: 240,
    steps: { checkout: 6, build: 20, selection: 4, 'tests: shard 1': 70, 'tests: shard 2': 20, e2e: 0, browser: 0 },
  });
  const refResult = sampleResult({
    commit: '2'.repeat(40),
    wallSeconds: 90,
    cpuSeconds: 180,
    steps: { checkout: 6, build: 15, selection: 4, 'tests: shard 1': 45, 'tests: shard 2': 20, e2e: 0, browser: 0 },
  });

  const comparison = compareBenchResults(mainResult, refResult);
  assert.equal(comparison.wallDeltaSeconds, -30);
  assert.equal(comparison.wallDeltaPercent, -25);
  assert.equal(comparison.cpuDeltaSeconds, -60);
  assert.equal(comparison.cpuDeltaPercent, -25);
  assert.equal(comparison.steps.build!.deltaSeconds, -5);
  assert.equal(comparison.steps['tests: shard 1']!.deltaSeconds, -25);
  assert.equal(comparison.steps.checkout!.deltaSeconds, 0);

  const formatted = formatBenchComparison(comparison);
  assert.match(formatted, /-30(\.0)?s/);
  assert.match(formatted, /-25(\.0)?%/);
  assert.match(formatted, /build/);
  assert.match(formatted, /tests: shard 1/);

  // AC-3: worker guide's proof topic says in two lines that an item claiming a speed-up quotes this comparison.
  const proofGuide = guideText('proof');
  assert.match(proofGuide, /bench trial --compare/);
  assert.match(proofGuide, /speed-up/i);
});
