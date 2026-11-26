import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-2035 rework: the rework workspace starts from the submission head Mainworks registered in the
// shared object store — the branch's own tip once a requirements revision cleared the candidate —
// and the worker branch is never fetched or pushed. AC-1: a rework workspace for an item whose
// local branch head equals the submitted candidate starts with no git fetch or push, whatever
// origin holds for that branch; and a local head that differs from the candidate never starts the
// workspace — the registered candidate starts it, or, when no registered start can be honored, the
// rework is refused with the existing message. A recording runner proves both: it records every git
// it is asked to run and answers from a real checkout whose origin holds an older head of the
// branch. The workspace-level form of the same guarantees, against a remote that records and
// rejects every worker-ref operation, is tests/control-plane-rework-workspace.test.ts.

const branch = 'graphyard/gy-9-1';

/** A checkout whose branch was pushed to origin at an older head, then moved on: the stalest origin a rework can meet. */
async function repository() {
  const { root: work, origin } = await gitRepo({ label: 'rework-local-branch', files: {}, origin: true });
  git(work, 'checkout', '-q', '-b', branch);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'older');
  git(work, 'push', '-q', 'origin', branch);
  const pushed = git(work, 'rev-parse', `refs/remotes/origin/${branch}`);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'submitted');
  return { origin, work, pushed, candidate: git(work, 'rev-parse', 'HEAD'), git };
}

/** The recording runner: every git it is asked to run is recorded, then answered from the real repository. */
const recording = (calls: string[][]) => (async (_command: string, args: string[], options?: { cwd?: string }) => {
  calls.push(args);
  const result = spawnSync('git', args, { cwd: options?.cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}) as never;

/** The recorded calls that would reach the remote: the door's own network subcommands. */
const networked = (calls: string[][]) => calls.filter(args => ['clone', 'fetch', 'ls-remote', 'pull', 'push'].includes(String(args[0])));

test('unit:rework-local-branch — the local candidate head starts the workspace with no git fetch or push, whatever origin holds', async () => {
  const { registeredReworkHead } = await import('../src/master/branch-release.js');
  const { origin, work, pushed, candidate, git } = await repository();
  const calls: string[][] = [];
  assert.equal(await registeredReworkHead(work, branch, candidate, recording(calls)), candidate, 'the registered candidate is the start the workspace resets onto');
  assert.deepEqual(calls, [['rev-parse', '--verify', `refs/heads/${branch}`]], 'the start reads the local head alone');
  assert.deepEqual(networked(calls), [], 'no git network subcommand runs, though origin holds an older head');
  assert.equal(git(work, 'rev-parse', `refs/remotes/origin/${branch}`), pushed, 'the stale remote-tracking ref is untouched');
  assert.equal(git(origin, 'rev-parse', branch), pushed, 'origin still holds what it held: nothing was pushed');
  // A requirements revision that cleared the candidate leaves the registered branch holding the head.
  const cleared: string[][] = [];
  assert.equal(await registeredReworkHead(work, branch, undefined, recording(cleared)), candidate, 'with the candidate cleared, the branch\'s own tip is the start');
  assert.deepEqual(networked(cleared), [], 'the cleared-candidate start runs no git network subcommand either');
});

test('unit:rework-local-branch — a local head that differs from the candidate never starts the workspace; with no registered start to honor it refuses with the existing message', async () => {
  const { registeredReworkHead } = await import('../src/master/branch-release.js');
  const { work, pushed } = await repository();
  // The branch moved past the submitted head: the registered candidate starts the workspace, never the moved local head.
  const moved: string[][] = [];
  assert.equal(await registeredReworkHead(work, branch, pushed, recording(moved)), pushed, 'the registered candidate is the start, not the branch tip that moved past it');
  assert.deepEqual(networked(moved), [], 'resolving past a moved local head fetches and pushes nothing');
  // A registered start the store does not hold refuses with the existing message — the differing
  // local head is not substituted for it, and the refusal runs no network either.
  const missing: string[][] = [];
  await assert.rejects(registeredReworkHead(work, branch, 'b'.repeat(40), recording(missing)), /missing from the shared object store/);
  assert.deepEqual(networked(missing), [], 'a refusal fetches and pushes nothing, too');
  // No start object is registered at all: no head is bound, and the store holds no branch by the name.
  const unregistered: string[][] = [];
  await assert.rejects(registeredReworkHead(work, 'graphyard/gy-404-1', undefined, recording(unregistered)), /No start object is registered/);
  assert.deepEqual(networked(unregistered), [], 'the unregistered-start refusal fetches and pushes nothing');
});
