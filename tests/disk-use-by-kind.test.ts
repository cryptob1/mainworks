import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterStatusReport } from '../src/cli/master-status.js';
import { runCycle } from '../src/daemon/cycle.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3743: master status shows the coordinator's free disk, its 24-hour trend and the five largest
// kinds of Mainworks disk use, read at most once an hour on the loop's existing disk check.

const HOUR = 3_600_000;
const GB = 1_000_000_000;
const unreachable = async () => { throw new TypeError('fetch failed'); };

async function makeInstall(label: string) {
  const root = await temporaryDirectory(`${label}-root`);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const credentials = await temporaryDirectory(`${label}-credentials`);
  const credentialFile = join(credentials, 'coordinator.token');
  writeFileSync(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({
    version: 1, url: 'http://127.0.0.1:5', credentialFile,
    cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/disk-use', baseBranch: 'main', hostId: 'coord-a',
    masterAgentName: 'graphyard-master-disk-use', workers: [],
    run: { diskFloorGb: 30, worktreeRoot: await temporaryDirectory(`${label}-wt-root`) },
  }) as MasterConfig;
  return { root, config };
}

test('integration:disk-use-by-kind — master status shows free bytes, 24h change and the five largest kinds of Mainworks disk use, read at most once an hour', async () => {
  const { root, config } = await makeInstall('disk-use-int');
  const worktreesDir = join(root, '.graphyard', 'worktrees');
  const trialRunsDir = join(root, '.graphyard', 'trial-runs');
  const cliReleasesDir = join(root, 'cli-releases');
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(trialRunsDir, { recursive: true });
  mkdirSync(cliReleasesDir, { recursive: true });
  writeFileSync(join(worktreesDir, 'wt.bin'), Buffer.alloc(12_000, 1));
  writeFileSync(join(trialRunsDir, 'run.log'), Buffer.alloc(8_000, 2));
  writeFileSync(join(cliReleasesDir, 'cli.bin'), Buffer.alloc(4_000, 3));

  // Verify the diskUseByKind measurement helper directly (imported lazily so base tip fails cleanly).
  const headroom = await import('../src/daemon/disk-headroom.js') as Record<string, any>;
  const dockerDf = {
    Images: [
      { Repository: 'mainworks-local', Tag: 'abc', Size: '12GB' },
      { Repository: 'mainworks-local', Tag: 'def', Size: '8GB' },
      { Repository: 'mainworks-trial', Tag: 'local', Size: '9GB' },
      { Repository: 'graphyard-warm', Tag: '1', Size: '6GB' },
      { Repository: 'graphyard-trial', Tag: 'old', Size: '2GB' },
      { Repository: 'postgres', Tag: '16', Size: '50GB' },
    ],
    BuildCache: [{ Size: '4GB' }, { Size: '1GB' }],
  };

  let clock = Date.parse('2030-05-01T00:00:00Z');
  let freeGb = 120;
  let sizingCalls = 0;

  const effects: DaemonEffects & { diskUseByKind?: () => Promise<{ kind: string; bytes: number }[]> } = {
    snapshot: async () => ({ work: [] as Work[], now: new Date(clock).toISOString() }),
    agents: () => [],
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => {},
    persist: current => writeDaemonState(config, current),
    diskVolumes: async () => [{ path: '/home', freeBytes: freeGb * GB }],
    diskUseByKind: async () => {
      sizingCalls += 1;
      if (typeof headroom.measureDiskUseByKind !== 'function') return [];
      return headroom.measureDiskUseByKind(
        { worktrees: [worktreesDir], trialRuns: [trialRunsDir], cliReleases: [cliReleasesDir] },
        async () => JSON.stringify(dockerDf),
      );
    },
  };

  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => clock);

  const first = (await masterStatusReport(root, config, unreachable, async () => '')).diskHeadroom as any;
  assert.ok(first !== null, 'diskHeadroom is non-null above the floor');
  assert.equal(first.freeBytes, 120 * GB);
  assert.equal(first.change24hBytes, null, 'a single reading has no 24h change yet');
  assert.equal(sizingCalls, 1);
  assert.equal(first.top.length, 5, 'top holds at most the five largest kinds');
  assert.deepEqual(first.top, [
    { kind: 'images: mainworks-local', bytes: 20 * GB },
    { kind: 'images: mainworks-trial', bytes: 9 * GB },
    { kind: 'images: graphyard-warm', bytes: 6 * GB },
    { kind: 'build cache', bytes: 5 * GB },
    { kind: 'images: graphyard-trial', bytes: 2 * GB },
  ], 'postgres is excluded and the five largest Mainworks kinds are sorted descending');

  // 10 minutes later: within the hour, no new sizing pass or reading is taken.
  clock += 10 * 60_000;
  freeGb = 118;
  await runCycle(config, state, effects, () => clock);
  assert.equal(sizingCalls, 1, 'disk use is read at most once an hour');
  const cached = (await masterStatusReport(root, config, unreachable, async () => '')).diskHeadroom as any;
  assert.equal(cached.freeBytes, 120 * GB);

  // Advance 50 hours, dropping 1 GB per hour: keeps the last 48 readings and reports -24 GB over 24h.
  for (let hour = 1; hour <= 50; hour += 1) {
    clock = Date.parse('2030-05-01T00:00:00Z') + hour * HOUR;
    freeGb = 120 - hour;
    await runCycle(config, state, effects, () => clock);
  }
  assert.equal(sizingCalls, 51, 'exactly one sizing pass per hour');
  assert.equal((state as any).diskUse.readings.length, 48, 'keeps at most the last 48 readings');
  const after = (await masterStatusReport(root, config, unreachable, async () => '')).diskHeadroom as any;
  assert.equal(after.freeBytes, 70 * GB);
  assert.equal(after.change24hBytes, -24 * GB, '24h change reflects free disk 24 hours earlier');

  // Without Docker, directory kinds (worktrees, trial runs, CLI releases) are still measured and sorted.
  const withoutDocker = await headroom.measureDiskUseByKind(
    { worktrees: [worktreesDir], trialRuns: [trialRunsDir], cliReleases: [cliReleasesDir] },
    async () => { throw new Error('docker: not found'); },
  );
  assert.deepEqual(withoutDocker.map((entry: { kind: string }) => entry.kind), ['worktrees', 'trial runs', 'CLI releases']);
  assert.ok(withoutDocker.every((entry: { bytes: number }) => entry.bytes > 0));
});

test('e2e:disk-use-by-kind — master status on a running install shows a non-null diskHeadroom with at least one kind and its size', async () => {
  const { root, config } = await makeInstall('disk-use-e2e');
  const trialRunsDir = join(root, '.graphyard', 'trial-runs', 'run-1');
  mkdirSync(trialRunsDir, { recursive: true });
  writeFileSync(join(trialRunsDir, 'output.log'), Buffer.alloc(16_384, 7));

  const snapshot = async () => ({ work: [] as Work[], now: new Date().toISOString() });
  const real = daemonEffects(root, config, { snapshot, mutate: async () => undefined });
  const effects: DaemonEffects = {
    ...real,
    agents: () => [],
    herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => {},
    dispatchTick: async () => {},
    sweepCheckouts: async () => {},
    masterSession: undefined,
    mergeWriter: null,
    reclaimLease: undefined,
    endExpiredLease: undefined,
    recordSession: async () => {},
    persist: current => writeDaemonState(config, current),
  };

  const state = emptyDaemonState(config);
  await runCycle(config, state, effects);

  const report = await masterStatusReport(root, config, unreachable, async () => '');
  const diskHeadroom = report.diskHeadroom as any;
  assert.ok(diskHeadroom !== null, 'master status shows a non-null diskHeadroom');
  assert.ok(typeof diskHeadroom.freeBytes === 'number' && diskHeadroom.freeBytes > 0, `freeBytes is positive: ${diskHeadroom.freeBytes}`);
  assert.ok(Array.isArray(diskHeadroom.top) && diskHeadroom.top.length >= 1, 'at least one kind is reported');
  assert.ok(diskHeadroom.top.length <= 5, 'at most five kinds are reported');
  for (const entry of diskHeadroom.top) {
    assert.equal(typeof entry.kind, 'string');
    assert.ok(entry.kind.length > 0);
    assert.ok(typeof entry.bytes === 'number' && entry.bytes > 0, `${entry.kind} has positive bytes: ${entry.bytes}`);
  }
});
