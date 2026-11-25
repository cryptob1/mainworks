import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { batchGatePorts, batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { statusLine } from '../src/model/incidents.js';
import { HomeStatus } from '../web/components/home.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3833: master status and Home's status line show non-blank line counts in src/ and tests/
// for the latest verified commit and their change against seven days earlier (or oldest kept).

const repository = 'owner/code-size-trend';
const unreachable = async () => { throw new TypeError('fetch failed'); };
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
} as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();

async function makeInstall(label: string) {
  const root = await temporaryDirectory(`${label}-root`);
  git(root, 'init', '-q', '-b', 'main');
  const credentials = await temporaryDirectory(`${label}-credentials`);
  const credentialFile = join(credentials, 'coordinator.token');
  writeFileSync(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({
    version: 1,
    url: 'http://127.0.0.1:5',
    credentialFile,
    cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository,
    baseBranch: 'main',
    hostId: 'coord-a',
    masterAgentName: 'graphyard-master-code-size',
    workers: [],
    run: { worktreeRoot: await temporaryDirectory(`${label}-wt-root`) },
  }) as MasterConfig;
  return { root, config };
}

test('integration:code-size-trend — master status and Home status line show source and test counts with their seven-day (or oldest kept) change', async () => {
  const { root, config } = await makeInstall('code-size-int');
  const file = gateRecordPath(root);

  // Seed two readings 7 days apart.
  const base = bootstrapGate(repository, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  await writeGateRecord(file, {
    ...base,
    codeSize: [
      { day: '2030-05-01', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', source: 1200, tests: 2400 },
      { day: '2030-05-08', commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', source: 1120, tests: 2550 },
    ],
  } as any);

  const report = await masterStatusReport(root, config, unreachable, async () => '') as any;
  assert.deepEqual(report.codeSize, {
    day: '2030-05-08',
    commit: 'bbbbbbbbbbbb',
    source: 1120,
    tests: 2550,
    sourceChange: -80,
    testsChange: 150,
    baselineDay: '2030-05-01',
  });

  // Home's status line renders today's counts with the 7-day change in plain wording.
  const now = Date.parse('2030-05-08T12:00:00Z');
  const line = statusLine({ codeSize: report.codeSize } as any, [], [], now) as any;
  assert.equal(line.codeSize, 'Code 1,120 lines (−80 this week) · Tests 2,550 lines (+150)');
  const html = renderToStaticMarkup(createElement(HomeStatus, {
    work: [],
    status: { codeSize: report.codeSize },
    now,
    setView: () => {},
    setSelected: () => {},
  }));
  assert.match(html, /Code 1,120 lines \(−80 this week\) · Tests 2,550 lines \(\+150\)/);

  // Zero-count readings (repositories without src/ or tests/) are omitted from Home's status line.
  assert.equal(statusLine({ codeSize: { source: 0, tests: 0, sourceChange: null, testsChange: null } }, [], [], now).codeSize, null);

  // When all readings are within 7 days, compare against the oldest reading kept.
  await writeGateRecord(file, {
    ...base,
    codeSize: [
      { day: '2030-05-05', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', source: 1200, tests: 2400 },
      { day: '2030-05-08', commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', source: 1150, tests: 2425 },
    ],
  } as any);
  const recent = await masterStatusReport(root, config, unreachable, async () => '') as any;
  assert.deepEqual(recent.codeSize, {
    day: '2030-05-08',
    commit: 'bbbbbbbbbbbb',
    source: 1150,
    tests: 2425,
    sourceChange: -50,
    testsChange: 25,
    baselineDay: '2030-05-05',
  });
});

test('e2e:code-size-trend — on a running test install master status shows codeSize after the first verified commit and tracks the seven-day change', async () => {
  const { root, config } = await makeInstall('code-size-e2e');

  // Initial commit (becomes the rollout base).
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'tests', 'index.test.ts'), 'export const t = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  await writeGateRecord(gateRecordPath(root), bootstrapGate(repository, baseSha));

  // First commit to verify: 4 non-blank lines in src/, 3 non-blank lines in tests/.
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\n\nexport const b = 2;\n   \nexport const c = 3;\nexport const d = 4;\n');
  writeFileSync(join(root, 'tests', 'index.test.ts'), 'const x = 1;\n\nconst y = 2;\nconst z = 3;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first verified');
  let tip = git(root, 'rev-parse', 'HEAD');

  let clock = Date.parse('2030-05-01T10:00:00Z');
  const state = emptyDaemonState(config);
  const ports: MergeWriterReads = {
    baseBranch: 'main',
    now: () => clock,
    fetch: async () => tip,
    cores: 2,
    parallel: 1,
    git: async (args, extra) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...gitEnv, ...extra } }),
    gate: { root, repository },
    merge: async head => ({ mergeSha: head, files: [] }),
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: [], proofs: {} }),
    push: async () => 'pushed',
    holds: async () => false,
    record: async () => {},
  };
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [] as Work[], now: new Date(clock).toISOString() }),
    agents: () => [],
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => {},
    mergeWriter: ports,
    persist: async () => {},
  };

  // Verify the first commit.
  const firstFlight = await batchGateStep({ state, effects, snapshot: { work: [], now: new Date(clock).toISOString() }, now: () => clock, log: () => {} });
  await firstFlight?.gate;

  const firstReport = await masterStatusReport(root, config, unreachable, async () => '') as any;
  assert.deepEqual(firstReport.codeSize, {
    day: '2030-05-01',
    commit: tip.slice(0, 12),
    source: 4,
    tests: 3,
    sourceChange: null,
    testsChange: null,
    baselineDay: null,
  });

  // A second verified commit on the same day replaces that day's reading (one reading per day).
  clock = Date.parse('2030-05-01T18:00:00Z');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'same day');
  tip = git(root, 'rev-parse', 'HEAD');
  const sameDayFlight = await batchGateStep({ state, effects, snapshot: { work: [], now: new Date(clock).toISOString() }, now: () => clock, log: () => {} });
  await sameDayFlight?.gate;
  assert.equal((readGateRecord(gateRecordPath(root)) as any)?.codeSize?.length, 1, 'keeps one reading per day');

  // Seven days later: src shrinks from 5 to 3 (-2), tests grows from 3 to 5 (+2).
  clock = Date.parse('2030-05-08T10:00:00Z');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  writeFileSync(join(root, 'tests', 'index.test.ts'), 'const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nconst v = 5;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'seven days later');
  tip = git(root, 'rev-parse', 'HEAD');
  const weekFlight = await batchGateStep({ state, effects, snapshot: { work: [], now: new Date(clock).toISOString() }, now: () => clock, log: () => {} });
  await weekFlight?.gate;

  const weekReport = await masterStatusReport(root, config, unreachable, async () => '') as any;
  assert.deepEqual(weekReport.codeSize, {
    day: '2030-05-08',
    commit: tip.slice(0, 12),
    source: 3,
    tests: 5,
    sourceChange: -2,
    testsChange: 2,
    baselineDay: '2030-05-01',
  });
});

test('code-size-trend — repositories without src/ or tests/ record nothing and real git errors surface as a gate note', async () => {
  const { root, config } = await makeInstall('code-size-other');

  // Repository keeping code in lib/ (no src/ or tests/).
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib', 'main.go'), 'package main\nfunc main() {}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  await writeGateRecord(gateRecordPath(root), bootstrapGate(repository, baseSha));

  writeFileSync(join(root, 'lib', 'main.go'), 'package main\nfunc main() { println("hi") }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'next');
  const tip = git(root, 'rev-parse', 'HEAD');

  const clock = Date.parse('2030-05-01T10:00:00Z');
  const state = emptyDaemonState(config);
  const ports: MergeWriterReads = {
    baseBranch: 'main',
    now: () => clock,
    fetch: async () => tip,
    cores: 2,
    parallel: 1,
    git: async (args, extra) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...gitEnv, ...extra } }),
    gate: { root, repository },
    merge: async head => ({ mergeSha: head, files: [] }),
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 10, logTail: '', files: [], proofs: {} }),
    push: async () => 'pushed',
    holds: async () => false,
    record: async () => {},
  };
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [] as Work[], now: new Date(clock).toISOString() }),
    agents: () => [],
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => {},
    mergeWriter: ports,
    persist: async () => {},
  };

  const flight = await batchGateStep({ state, effects, snapshot: { work: [], now: new Date(clock).toISOString() }, now: () => clock, log: () => {} });
  await flight?.gate;

  const record = readGateRecord(gateRecordPath(root));
  assert.equal(record?.codeSize, undefined, 'does not record 0/0 when repository has neither src/ nor tests/');
  assert.equal(record?.notes?.some(line => line.startsWith('code-size: ')), false, 'missing src/ or tests/ is not an error');
  const report = await masterStatusReport(root, config, unreachable, async () => '') as any;
  assert.equal(report.codeSize, null);

  // A real git failure (status !== 1, e.g. bad object) throws instead of returning 0 so gateFlight sets the code-size note.
  const gatePorts = batchGatePorts({ ...ports, git: ports.git! }, []);
  await assert.rejects(() => gatePorts.codeSize!('0000000000000000000000000000000000000000'));
});
