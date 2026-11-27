import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapGate, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { recordTestSelection } from '../src/merge-writer/test-selection.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3840: master status counts the failing test files the release checks caught that no item trial of their batch selected.

const repository = 'owner/narrowing-miss-rate';
const unreachable = async () => { throw new TypeError('fetch failed'); };

async function makeInstall(label: string, files?: Record<string, string>) {
  const { root, head } = await gitRepo({ label: `${label}-root`, files });
  const credentials = await temporaryDirectory(`${label}-credentials`);
  const credentialFile = join(credentials, 'coordinator.token');
  writeFileSync(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({
    version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository, baseBranch: 'main', hostId: 'coord-a', masterAgentName: 'graphyard-master-narrowing', workers: [],
    run: { worktreeRoot: await temporaryDirectory(`${label}-wt-root`) },
  }) as MasterConfig;
  return { root, head, config };
}

test('integration:narrowing-miss-rate — a release check whose failing file no trial of its batch selected counts as missed by narrowing', async () => {
  const { root, config } = await makeInstall('narrowing-int');
  await writeGateRecord(gateRecordPath(root), {
    ...bootstrapGate(repository, 'b'.repeat(40)),
    sweeps: [
      // Caught tests/a.test.ts, which GY-1's trial selected: not a miss.
      { at: '2030-05-01T10:00:00.000Z', items: ['GY-1'], failed: ['tests/a.test.ts'] },
      // GY-3 has no recorded trial (it may have run every test): nothing in its batch counts.
      { at: '2030-05-01T11:00:00.000Z', items: ['GY-2', 'GY-3'], failed: ['tests/c.test.ts'] },
      // Caught tests/b.test.ts, which neither GY-4's nor GY-5's trial selected: one miss.
      { at: '2030-05-01T12:00:00.000Z', items: ['GY-4', 'GY-5'], failed: ['tests/b.test.ts'] },
      { at: '2030-05-01T13:00:00.000Z', items: ['GY-6'], failed: [] },
    ],
  } as any);
  await recordTestSelection(root, { selected: 1, reachable: 4, key: 'GY-1', files: ['tests/a.test.ts'] });
  await recordTestSelection(root, { selected: 1, reachable: 4, key: 'GY-2', files: ['tests/a.test.ts'] });
  await recordTestSelection(root, { selected: 1, reachable: 4, key: 'GY-4', files: ['tests/a.test.ts'] });
  await recordTestSelection(root, { selected: 2, reachable: 4, key: 'GY-5', files: ['tests/a.test.ts', 'tests/d.test.ts'] });

  const report = await masterStatusReport(root, config, unreachable, async () => '') as any;
  assert.deepEqual(report.testSelection.missedByNarrowing, { releaseChecks: 4, missed: 1, latest: { file: 'tests/b.test.ts', item: 'GY-4, GY-5', at: '2030-05-01T12:00:00.000Z' } });
  assert.equal(report.testSelection.medianShareSelected, '25%', 'the share line still reads');
});

test('e2e:narrowing-miss-rate — on a running test install master status shows missedByNarrowing after a release check', { timeout: 120_000 }, async () => {
  const { root, head: verified, config } = await makeInstall('narrowing-e2e', { 'tests/a.test.ts': 'export {};\n', 'tests/b.test.ts': 'export {};\n' });
  await writeGateRecord(gateRecordPath(root), bootstrapGate(repository, verified));

  // GY-1 lands as a merge commit; its item trial selected only tests/a.test.ts, and its change breaks tests/b.test.ts.
  git(root, 'checkout', '-q', '-b', 'gy-1');
  writeFileSync(join(root, 'src.ts'), 'export const broken = true;\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'GY-1: change');
  git(root, 'checkout', '-q', 'main');
  git(root, 'merge', '-q', '--no-ff', '-m', 'Merge GY-1: change', 'gy-1');
  const tip = git(root, 'rev-parse', 'HEAD');
  await recordTestSelection(root, { selected: 1, reachable: 2, all: 2, key: 'GY-1', files: ['tests/a.test.ts'] });

  const work = [{ key: 'GY-1', title: 'change', status: 'done', criteria: [] }] as unknown as Work[];
  const clock = Date.parse('2030-05-01T10:00:00Z');
  const state = emptyDaemonState(config);
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock, fetch: async () => tip, cores: 2, parallel: 1,
    git: async (args, extra) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...extra } }),
    gate: { root, repository },
    merge: async head => ({ mergeSha: head, files: [] }),
    // The release check's sweep fails tests/b.test.ts on the batch tip only.
    trial: async (commit, files) => {
      const failed = commit === tip && files.includes('tests/b.test.ts') ? ['tests/b.test.ts'] : [];
      return { build: 'pass', tests: { passed: files.length - failed.length, failed, files: files.length }, durationMs: 10, logTail: '', files: [], proofs: {} };
    },
    push: async () => 'pushed',
    holds: async () => false,
    record: async () => {},
  };
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, mergeWriter: reads, persist: async () => {},
  };
  // The gate sweeps every test file, so tests/b.test.ts runs in the batch.
  await writeGateRecord(gateRecordPath(root), { ...readGateRecord(gateRecordPath(root))!, inFlight: { tip, startedAt: new Date(clock).toISOString(), files: ['src.ts'], checks: ['build', 'test:tests/a.test.ts', 'test:tests/b.test.ts'], results: {} } });
  const flight = await batchGateStep({ state, effects, snapshot: { work, now: new Date(clock).toISOString() }, now: () => clock, log: () => {} });
  await flight?.gate;

  const record = readGateRecord(gateRecordPath(root))!;
  assert.equal(record.lastOutcome?.outcome, 'reverted', JSON.stringify(record.lastOutcome));
  const report = await masterStatusReport(root, config, unreachable, async () => '') as any;
  assert.deepEqual(report.testSelection.missedByNarrowing, { releaseChecks: 1, missed: 1, latest: { file: 'tests/b.test.ts', item: 'GY-1', at: new Date(clock).toISOString() } });
});
