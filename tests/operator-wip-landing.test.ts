import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// The code under test is imported inside each test, so a base without it fails as test cases.
async function repository(branch: string) {
  const base = await temporaryDirectory('operator-wip'), origin = join(base, 'origin.git');
  const { root: work } = await gitRepo({ root: join(base, 'work'), branch, files: {}, message: 'one' });
  git(base, 'init', '--bare', '--quiet', origin); git(work, 'remote', 'add', 'origin', origin);
  return { origin, work };
}
const remoteHeads = (origin: string) => spawnSync('git', ['-C', origin, 'branch', '--list'], { encoding: 'utf8' }).stdout;

test('unit:worktree-starts-from-registered-head — the rework start resolves the registered local head with no fetch and no push; nothing registered or missing from the store refuses', async () => {
  const { registeredReworkHead } = await import('../src/master/branch-release.js');
  const { origin, work } = await repository('graphyard/gy-3-1');
  const network: string[] = [];
  const run = ((command: string, args: string[], options: { cwd: string }) => {
    if (args[0] === 'fetch' || args[0] === 'push') { network.push(args[0]); throw new Error(`a rework start runs no git ${args[0]}`); }
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  }) as never;
  git(work, 'commit', '--allow-empty', '-m', 'second');
  const second = git(work, 'rev-parse', 'HEAD');
  assert.equal(await registeredReworkHead(work, 'graphyard/gy-3-1', second, run), second);
  // A requirements revision that cleared the candidate leaves the registered branch holding the head.
  assert.equal(await registeredReworkHead(work, 'graphyard/gy-3-1', undefined, run), second);
  assert.deepEqual(network, [], 'the registered local head is read from the object store alone');
  assert.match(remoteHeads(origin).trim(), /^$/, 'the fake remote holds no worker branch and was never pushed to');
  // A registered head the store does not hold refuses, and so does a start object nothing registers.
  await assert.rejects(registeredReworkHead(work, 'graphyard/gy-3-1', 'b'.repeat(40), run), /missing from the shared object store/);
  await assert.rejects(registeredReworkHead(work, 'graphyard/gy-3-9', undefined, run), /No start object is registered/);
  // An interrupted attempt's commits past the registered head are partial work, never the start: the registered head still resolves.
  git(work, 'commit', '--allow-empty', '-m', 'WIP: partial');
  assert.equal(await registeredReworkHead(work, 'graphyard/gy-3-1', second, run), second);
});
