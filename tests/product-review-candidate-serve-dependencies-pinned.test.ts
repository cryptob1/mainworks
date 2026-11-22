import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';

// GY-3651, GY-3664: tests/product-review-candidate-serve-dependencies.test.ts failed on main and
// passed on its re-run. Two causes:
// 1. Its managed worktree root sits under the suite's tmpdir and needs durable storage
//    (verifyWorktreeRoot refuses a memory-backed volume), so the file must stay on this machine
//    rather than going to a remote shard.
// 2. It hardcoded servePort = 4398, so concurrent runs on the same host could collide on that port;
//    it must allocate an ephemeral free port with freePort().

test('unit:product-review-candidate-serve-dependencies-pinned — the fixture stays on this machine and allocates a free serve port instead of hardcoding one', async () => {
  const source = await readFile(new URL('./product-review-candidate-serve-dependencies.test.ts', import.meta.url), 'utf8');
  assert.equal(remoteableTestFile(source), false, 'the fixture\'s managed worktree root needs durable storage, so it never goes to a remote shard');
  assert.doesNotMatch(source, /\bconst\s+servePort\s*=\s*\d+/, 'hardcoding a fixed serve port collides across concurrent runs');
  assert.match(source, /\bservePort\s*=\s*await\s+freePort\(\)/, 'the fixture allocates an ephemeral free port with freePort()');
});
