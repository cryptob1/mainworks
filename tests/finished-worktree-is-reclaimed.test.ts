import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterStatusReport } from '../src/cli/master-status.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3691: the loop's close step removes a finished item's working copy within a cycle, and an
// item's earlier attempt's once a later attempt holds the item, never one a live session or lease
// uses; master status reports the working copies' disk use, which falls by what was removed.
const HOST = 'loop-host';
const scratchBytes = 5 * 1024 * 1024;

test('e2e:finished-worktree-is-reclaimed — a done item\'s working copy with 5 MB of scratch is gone within two cycles and the reported disk figure falls by at least that much; an earlier attempt goes, the live one stays', async () => {
  const install = await temporaryDirectory('finished-worktree-install');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: install, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(install, '.gitignore'), '.graphyard/\n');
  git('add', '.gitignore');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
  const credentialFile = join(await temporaryDirectory('finished-worktree-credentials'), 'coordinator.token');
  await writeFile(credentialFile, `${'c'.repeat(40)}\n`, { mode: 0o600 });
  const worktrees = join(install, '.graphyard', 'worktrees');
  // The stub Builder: a checkout of its attempt that leaves 5 MB of scratch behind, as a test run does.
  const build = async (key: string, epoch: number) => {
    const path = join(worktrees, `${key}-${epoch}`);
    git('worktree', 'add', '-q', '-b', `graphyard/${key.toLowerCase()}-${epoch}`, path);
    await mkdir(join(path, '.graphyard', 'scratch'), { recursive: true });
    await writeFile(join(path, '.graphyard', 'scratch', 'leftover'), Buffer.alloc(scratchBytes, 1));
    return path;
  };
  const finished = await build('GY-1', 1), earlier = await build('GY-2', 1), current = await build('GY-2', 2);

  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const running = (key: string, epoch: number) => ({ id: `${key}:${epoch}`, kind: 'implementation', principal: 'worker-a', epoch, runtime: 'claude', host: HOST, subject: key, state: 'running' });
  const space = (path: string, epoch: number) => ({ host: HOST, epoch, path, owner: 'worker-a', branch: 'b' });
  const building = { id: 'w1', key: 'GY-1', stage: 'build', epoch: 1, lease: { owner: 'worker-a', epoch: 1, expiresAt }, sessions: [running('GY-1', 1)], workspaces: [space(finished, 1)], updatedAt: new Date().toISOString() };
  const reworked = { id: 'w2', key: 'GY-2', stage: 'build', epoch: 2, lease: { owner: 'worker-a', epoch: 2, expiresAt }, sessions: [running('GY-2', 2)], workspaces: [space(earlier, 1), space(current, 2)], updatedAt: new Date().toISOString() };
  let work: unknown[] = [building, reworked];

  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/finished-worktree', baseBranch: 'main', hostId: HOST, masterAgentName: 'graphyard-master-finished', workers: [],
    run: { worktreeRoot: await temporaryDirectory('finished-worktree-root') } }) as MasterConfig;
  const snapshot = async () => ({ work: work as Work[], now: new Date().toISOString() });
  const real = daemonEffects(install, config, { snapshot, mutate: async () => undefined });
  const effects: DaemonEffects = {
    ...real,
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    closeSession: () => {}, dispatch: async () => {}, dispatchTick: async () => {}, sweepCheckouts: async () => {},
    masterSession: undefined, mergeWriter: null, reclaimLease: undefined, endExpiredLease: undefined, recordSession: async () => {},
    persist: current => writeDaemonState(config, current),
  };
  const state = emptyDaemonState(config);
  const reported = async () => (await masterStatusReport(install, config, async () => { throw new TypeError('fetch failed'); }, async () => '')).leftovers?.worktreeDisk?.bytes;

  // While both items build: the earlier attempt's copy goes, the live ones stay, and the disk is read.
  await runCycle(config, state, effects);
  await runCycle(config, state, effects);
  assert.ok(!existsSync(earlier), 'the earlier attempt\'s working copy is removed once a later attempt holds the item');
  assert.ok(existsSync(finished) && existsSync(current), 'a copy a live lease and session use is never touched');
  const before = await reported();
  assert.ok(typeof before === 'number' && before >= 2 * scratchBytes, `master status reports the working copies' disk: ${before}`);

  // The item reaches done: the live loop's snapshot then holds only its settled summary.
  work = [{ id: 'w1', key: 'GY-1', stage: 'done' }, reworked];
  await runCycle(config, state, effects);
  await runCycle(config, state, effects);
  assert.ok(!existsSync(finished), 'the done item\'s working copy is gone within two cycles');
  assert.ok(existsSync(current), 'the live attempt\'s copy stays');
  const after = await reported();
  assert.ok(typeof after === 'number' && before - after >= scratchBytes, `the reported disk fell by at least 5 MB: ${before} -> ${after}`);
});
