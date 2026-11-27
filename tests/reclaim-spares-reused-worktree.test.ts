import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { removeAttemptWorktree, worktreesDirectory } from '../src/master/worktrees.js';
import { reworkWorktreePath } from '../src/cli/workspace-worktree.js';
import type { Work } from '../src/model.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3689: a rework's next epoch reuses its Builder's worktree path (GY-3632). The close step that
// reclaims ended attempts' worktrees runs before, and beside, that launch, so it must leave the path
// the rework will start in; an ended attempt whose path nothing reuses is still removed.

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' });

async function yard(name: string) {
  const { root } = await gitRepo({ label: name, files: { 'file.txt': 'base\n' } });
  mkdirSync(worktreesDirectory(root), { recursive: true });
  const now = Date.now();
  // An item whose epoch-1 attempt just ended: submitted (a rework will reuse its path) or not.
  const item = (key: string, submitted: boolean) => {
    const branch = `graphyard/${key.toLowerCase()}-1`, path = join(worktreesDirectory(root), `${key}-1`);
    git(root, 'worktree', 'add', '-q', '-b', branch, path);
    const endedAt = new Date(now - 60_000).toISOString();
    return { id: key, key, stage: 'build', epoch: 1, lease: null, sessions: [], updatedAt: endedAt, attemptEnd: { epoch: 1, end: submitted ? 'submitted' : 'released', endedAt },
      ...(submitted ? { submission: { epoch: 1, sha: 'a'.repeat(40) } } : {}),
      workspaces: [{ host: 'machine-a', epoch: 1, path, owner: 'worker', branch }] } as unknown as Work;
  };
  const cycle = async (work: Work[]) => {
    const effects: DaemonEffects = {
      snapshot: async () => ({ work, now: new Date(now).toISOString() }),
      agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {},
      removeWorktree: (path, force) => removeAttemptWorktree(root, path, run, force),
    };
    await runCycle(config, emptyDaemonState(config), effects, () => now, undefined, () => {});
  };
  return { root, now, item, cycle };
}

test('integration:reclaim-spares-reused-worktree — reclaim keeps the worktree the rework reuses and removes one nothing reuses', async () => {
  const { item, cycle, now } = await yard('reclaim-spares-reused');
  const rework = item('GY-1', true), abandoned = item('GY-2', false);
  await cycle([rework, abandoned]);
  const path = rework.workspaces[0]!.path;
  assert.equal(existsSync(path), true, 'the ended attempt\'s worktree the rework reuses is kept');
  assert.equal(existsSync(abandoned.workspaces[0]!.path), false, 'an ended attempt whose path no newer epoch uses is still removed');
  // The rework's epoch is dispatched to the same path: both epochs name it, the new one holds the lease.
  const dispatched = { ...rework, epoch: 2, lease: { epoch: 2, owner: 'worker', expiresAt: new Date(now + 600_000).toISOString() },
    workspaces: [...rework.workspaces, { ...rework.workspaces[0]!, epoch: 2 }] } as unknown as Work;
  await cycle([dispatched]);
  assert.equal(existsSync(path), true, 'the new epoch\'s worktree survives the old epoch\'s reclaim');
});

test('e2e:reclaim-spares-reused-worktree — an item re-dispatched right after its attempt ends starts its worker with no ENOENT', async () => {
  const { item, cycle } = await yard('reclaim-spares-redispatch');
  const rework = item('GY-3', true), branch = rework.workspaces[0]!.branch;
  // The loop's close step reclaims the ended attempt, then the rework launch takes the reused path.
  await cycle([rework]);
  const reuse = reworkWorktreePath(rework as never, branch, 'machine-a');
  assert.equal(reuse, rework.workspaces[0]!.path, 'the rework reuses its Builder\'s worktree path');
  // What the worker's launch does first: resolve its worktree and read its branch there.
  const cwd = realpathSync(reuse!);
  assert.equal(git(cwd, 'symbolic-ref', '--short', 'HEAD').trim(), branch, 'the worker starts in its worktree on its branch');
});
