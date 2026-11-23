import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';

// GY-3648: the batch gate's check test:tests/product-review-installs-differing-lock.test.ts failed on
// d6390204cd78 and passed on its re-run because only the failing batch had scheduled the file's group
// onto a remote shard. A shard container's writable temporary storage is its tmpfs /tmp (HOME included),
// so the suite's durable relocation lands on the same tmpfs, and Mainworks refuses a managed worktree
// root on memory-backed storage — the check's own setup failed there and passes wherever it runs local.
// A test that hands Mainworks a managed worktree root (worktreeRoot) names what a host's shard cannot
// give it, so it stays local-only and the check no longer depends on where a batch schedules it.

test('unit:product-review-installs-differing-lock-pinned — the differing-lock check names worktreeRoot, so a batch can never schedule it onto a remote shard', async () => {
  const file = await readFile(join(new URL('..', import.meta.url).pathname, 'tests', 'product-review-installs-differing-lock.test.ts'), 'utf8');
  assert.ok(file.includes('worktreeRoot'), 'the check still sets up a managed worktree root');
  assert.equal(remoteableTestFile(file), false, 'a managed worktree root needs durable storage, which a remote shard container has none of');
});
