import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { volatileFilesystem } from '../src/install/worktree-root.js';

// GY-4097: the scheduled full run on 1b62770d failed e2e:lease-survives-message-and-unblock after 300 s.
// That run's catalog shard worked in a tmpfs worktree (fixed by GY-4105), so headlessWorkers' setupMaster
// refused the tmpfs worktree root, and the fixture's leaked server and store kept the file alive until the
// step bound killed it. A setup failure must now end the file at once and name the cause.

const repo = fileURLToPath(new URL('..', import.meta.url));

test('unit:e2e-lease-survives-message-and-unblock-pinned — the lease case run from a tmpfs checkout ends promptly and names the tmpfs refusal', { timeout: 120_000 }, async () => {
  assert.equal(volatileFilesystem('/dev/shm'), 'tmpfs', '/dev/shm must be a tmpfs to reproduce the shard layout');
  const cwd = await mkdtemp('/dev/shm/gy-lease-pin-');
  try {
    // The child is its own test run, not a subtest of this one.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const output = await new Promise<string>(resolve => execFile(process.execPath,
      ['--import', join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs'), '--test', join(repo, 'tests', 'lease-survives-message-and-unblock.test.ts')],
      { cwd, env, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 16 << 20 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`)));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 60_000, `the file hung for ${elapsed} ms after its fixture setup failed`);
    assert.match(output, /managed worktree root .* is on a tmpfs/, output.slice(-2000));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
