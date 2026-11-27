import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliContext } from '../src/cli/context.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { launchFailureFixture } from './helpers/launch-failure-fixture.js';

// GY-3413: GY-3406's record named a submission epoch no workspace was registered for, so every
// launch failed at `worktree` with "Submitted workspace branch is missing" and the loop relaunched
// it every 8 s for hours, reaching epoch 4500+. The worktree now takes the candidate's branch, else
// the latest workspace's; and a launch failing twice with the same reason backs the item off on
// every runtime, with one master status line naming it, the reason and when it retries.
// Imported at run time, so the file run against the base fails case by case rather than at load.
const { createWorktree } = await import('../src/cli/workspace-worktree.js');
const proof = 'integration:worktree-epoch-fallback';
const branch = 'graphyard/gy-1-1';

/** A coordinator checkout holding the submitted branch, with no worktree for it. */
async function repository() {
  const { root } = await gitRepo({ label: 'worktree-epoch-fallback', files: {} });
  git(root, 'checkout', '-q', '-b', branch);
  await writeFile(join(root, 'feature.txt'), 'the submitted work\n');
  git(root, 'add', 'feature.txt');
  git(root, 'commit', '-q', '-m', 'the submitted head');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  return { root, head };
}

/** Builds epoch 9's worktree as the launcher does, against a server stub that accepts the reservation. */
async function worktree(root: string, subject: Record<string, unknown>) {
  const printed: { path: string; branch: string }[] = [];
  const context = {
    args: ['9'],
    api: async (path: string) => path === 'status' ? { repository: null, now: new Date().toISOString() } : {},
    print: (value: { path: string; branch: string }) => printed.push(value),
    repositoryRoot: () => root, individualHostId: () => 'test-host',
  } as unknown as CliContext;
  const previous = process.cwd();
  process.chdir(root);
  try { await createWorktree(context, subject); } finally { process.chdir(previous); }
  return printed[0];
}

const stale = (fields: Record<string, unknown>) => ({ id: 'id-1', key: 'GY-1', epoch: 9, submission: { epoch: 4500 }, lease: { owner: 'worker-a', epoch: 9, expiresAt: new Date(Date.now() + 600_000).toISOString() }, ...fields });

test(`${proof} — a submission epoch with no workspace builds from candidate.branch at the candidate head`, async () => {
  const { root, head } = await repository();
  try {
    const built = await worktree(root, stale({ candidate: { sha: head, branch }, workspaces: [] }));
    assert.equal(built.branch, branch);
    assert.equal(git(built.path, 'rev-parse', 'HEAD'), head);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test(`${proof} — with no candidate, the latest workspace's branch serves`, async () => {
  const { root, head } = await repository();
  try {
    const built = await worktree(root, stale({ candidate: null, workspaces: [
      { host: 'test-host', path: join(root, 'gone-0'), epoch: 1, owner: 'worker-a', branch: 'graphyard/gy-1-old' },
      { host: 'test-host', path: join(root, 'gone-1'), epoch: 3, owner: 'worker-a', branch }] }));
    assert.equal(built.branch, branch);
    assert.equal(git(built.path, 'rev-parse', 'HEAD'), head);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test(`${proof} — a launch failing twice with the same reason backs off on every runtime with no epoch increase, and master status names the item, the reason and the retry`, async () => {
  const f = await launchFailureFixture();
  await f.cycle(0);
  assert.equal(f.launches(), 1);
  // The first failure holds its own runtime; another runtime tries and fails the same way.
  await f.cycle(5_000);
  assert.equal(f.launches(), 2, 'the second runtime launches once');
  for (const at of [10_000, 30_000, 60_000, 100_000]) await f.cycle(at);
  assert.equal(f.launches(), 2, 'no launch, so no epoch increase, while the backoff stands');
  const line = (await f.status(100_000)).attention.find((entry: { subject?: string }) => entry.subject === 'GY-1');
  assert.ok(line, 'master status carries the item');
  assert.ok(line.text.includes(f.reason(2)), `the line names the reason: ${line.text}`);
  assert.match(line.text, /not relaunched until 2030-01-01T00:02:05\.000Z/);
  await f.cycle(126_000);
  assert.equal(f.launches(), 3, 'the item is tried again once the backoff ends');
});
