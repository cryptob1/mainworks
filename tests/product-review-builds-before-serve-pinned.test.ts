import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';

// GY-3660, GY-3668: tests/product-review-builds-before-serve.test.ts failed on main and passed on its
// re-run. Two causes:
// 1. Its managed worktree root sits under the suite's tmpdir and must be durable (verifyWorktreeRoot
//    refuses a tmpfs), so the file must stay on this machine rather than go to a remote shard.
// 2. It hardcoded servePort = 4397, the port tests/product-review-environment.test.ts also serves on,
//    and both files run on this machine at once; it must allocate an ephemeral port with freePort().

test('unit:product-review-builds-before-serve-pinned — the fixture stays on this machine and allocates a free serve port instead of hardcoding one', async () => {
  const source = await readFile(new URL('./product-review-builds-before-serve.test.ts', import.meta.url), 'utf8');
  assert.equal(remoteableTestFile(source), false, 'the fixture\'s managed worktree root needs durable storage, so it never goes to a remote shard');
  assert.doesNotMatch(source, /\bconst\s+servePort\s*=\s*\d+/, 'hardcoding a fixed serve port collides across concurrent runs');
  assert.match(source, /\bservePort\s*=\s*await\s+freePort\(\)/, 'the fixture allocates an ephemeral free port with freePort()');
});
