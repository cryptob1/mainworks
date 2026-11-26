import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { removeAttemptWorktree, worktreesDirectory } from '../src/master/worktrees.js';
import type { Work } from '../src/model.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3191, GY-3691: a done item's ended-attempt worktree is removed within the cycle, even when the
// attempt left modified and untracked files; an open item's is kept.

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const hour = 60 * 60 * 1000;

test('unit:tests/finished-worktree-removal.test.ts — a done item\'s dirty worktree goes within the cycle, however recently its attempt ended; an open item\'s stays', async () => {
  const { root } = await gitRepo({ label: 'finished-worktree', files: { 'file.txt': 'base\n' } });
  mkdirSync(worktreesDirectory(root), { recursive: true });
  const now = Date.parse('2030-04-02T12:00:00Z');
  const item = (key: string, stage: string, endedHoursAgo: number) => {
    const path = join(worktreesDirectory(root), `${key}-1`);
    git(root, 'worktree', 'add', '-q', '-b', `graphyard/${key.toLowerCase()}-1`, path);
    writeFileSync(join(path, 'file.txt'), 'modified\n');
    writeFileSync(join(path, 'untracked.txt'), 'new\n');
    const endedAt = new Date(now - endedHoursAgo * hour).toISOString();
    return { id: key, key, stage, lease: null, sessions: [], updatedAt: endedAt, attemptEnd: { epoch: 1, end: 'submitted', endedAt },
      workspaces: [{ host: 'machine-a', epoch: 1, path, owner: 'worker', branch: `graphyard/${key.toLowerCase()}-1` }] };
  };
  const work = [item('GY-1', 'done', 25), item('GY-2', 'build', 25), item('GY-3', 'done', 1)] as unknown as Work[];
  const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
    removeWorktree: (path, force) => removeAttemptWorktree(root, path, run, force),
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => now, undefined, () => {});
  const [done, open, recent] = work.map(entry => entry.workspaces[0]!.path);
  assert.equal(existsSync(done!), false, 'the done item\'s worktree ended 25 h ago is removed with its uncommitted files');
  assert.equal(existsSync(open!), true, 'an open item\'s worktree is kept');
  assert.equal(existsSync(recent!), false, 'a done item\'s worktree ended an hour ago is removed too (GY-3691)');
  assert.ok(git(root, 'branch', '--list', 'graphyard/gy-1-1').trim(), 'the removed worktree\'s branch survives');
});

// GY-3341, GY-3691: the loop's snapshot no longer carries settled deliveries, so their leftover
// worktrees are reclaimed from the disk: a `GY-N-EPOCH` tree of an item the snapshot does not hold
// goes within the cycle, a tree newer than the snapshot stays (the snapshot may predate the item that
// just claimed it), and so does every tree of an item the snapshot holds — that item's own pass decides those.
test('unit:tests/finished-worktree-removal.test.ts — a settled delivery\'s leftover worktree is reclaimed from the disk within the cycle', async () => {
  const { root } = await gitRepo({ label: 'settled-worktree', files: { 'file.txt': 'base\n' } });
  mkdirSync(worktreesDirectory(root), { recursive: true });
  const now = Date.now();
  const tree = (name: string, changedHoursAgo: number) => {
    const path = join(worktreesDirectory(root), name);
    git(root, 'worktree', 'add', '-q', '-b', `graphyard/${name.toLowerCase()}`, path);
    writeFileSync(join(path, 'untracked.txt'), 'new\n');
    const changedAt = now - changedHoursAgo * hour;
    // The worktree's own mtime is what the loop reads: age it, its changed file and itself.
    execFileSync('touch', ['-d', new Date(changedAt).toISOString(), join(path, 'untracked.txt'), path]);
    return { path, changedAt };
  };
  // Settled deliveries the loop's snapshot no longer holds, one changed 25 h ago and one 1 h ago; a
  // tree made after the snapshot was read; an open item's tree the snapshot does hold; and a foreign directory.
  const oldSettled = tree('GY-9-1', 25), youngSettled = tree('GY-8-2', 1), newer = tree('GY-6-1', -0.1), open = tree('GY-7-1', 25);
  const foreign = join(worktreesDirectory(root), 'not-mainworks');
  mkdirSync(foreign);
  const openItem = { id: 'GY-7', key: 'GY-7', stage: 'build', lease: null, sessions: [], updatedAt: new Date(now).toISOString(),
    workspaces: [{ host: 'machine-a', epoch: 1, path: open.path, owner: 'worker', branch: 'graphyard/gy-7-1' }] } as unknown as Work;
  const stat = (path: string) => ({ path, changedAt: statSync(path).mtimeMs });
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [openItem], now: new Date(now).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
    removeWorktree: (path, force) => removeAttemptWorktree(root, path, (command, args) => execFileSync(command, args, { encoding: 'utf-8', stdio: 'pipe' }), force),
    attemptWorktrees: async () => [stat(oldSettled.path), stat(youngSettled.path), stat(newer.path), stat(open.path), stat(foreign)],
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => now, undefined, () => {});
  assert.equal(existsSync(oldSettled.path), false, 'the settled delivery\'s day-old worktree is removed from the disk');
  assert.equal(existsSync(youngSettled.path), false, 'and so is one changed an hour ago (GY-3691)');
  assert.equal(existsSync(newer.path), true, 'a tree newer than the snapshot waits for the next cycle');
  assert.equal(existsSync(open.path), true, 'an open item\'s tree is the snapshot pass\'s alone, and it keeps it');
  assert.equal(existsSync(foreign), true, 'a directory Mainworks did not name is never touched');
  assert.ok(Object.values(state.actions).some(action => action.kind === 'reclaim' && action.detail.includes('GY-9')), 'the reclaim says which settled item it removed for');
});

// GY-3691 review: an ended attempt whose dirty tree Git refused to remove three times while its item
// stayed on that epoch is still removed, forced, once a later attempt holds the item.
test('unit:tests/finished-worktree-removal.test.ts — an earlier attempt\'s dirty tree refused three times while current goes once a later attempt holds the item', async () => {
  const { root } = await gitRepo({ label: 'earlier-attempt', files: { 'file.txt': 'base\n' } });
  mkdirSync(worktreesDirectory(root), { recursive: true });
  const path = join(worktreesDirectory(root), 'GY-5-1');
  git(root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-5-1', path);
  writeFileSync(join(path, 'untracked.txt'), 'new\n');
  const space = { host: 'machine-a', epoch: 1, path, owner: 'worker', branch: 'graphyard/gy-5-1' };
  let item = { id: 'GY-5', key: 'GY-5', stage: 'review', epoch: 1, lease: null, sessions: [], updatedAt: new Date().toISOString(), workspaces: [space] } as unknown as Work;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [item], now: new Date().toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
    removeWorktree: (target, force) => removeAttemptWorktree(root, target, (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' }), force),
  };
  const state = emptyDaemonState(config);
  for (let cycle = 0; cycle < 4; cycle++) await runCycle(config, state, effects, Date.now, undefined, () => {});
  assert.equal(existsSync(path), true, 'Git keeps the dirty tree while its attempt is the current one');
  item = { ...item, stage: 'build', epoch: 2 } as Work;
  await runCycle(config, state, effects, Date.now, undefined, () => {});
  assert.equal(existsSync(path), false, 'a later attempt holds the item: the earlier tree is removed, forced');
});
