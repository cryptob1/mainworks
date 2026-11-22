import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';

// GY-3658: tests/graphyard-e2e-serve.test.ts runs the delivery-pipeline case, whose script
// (scripts/e2e-delivery-pipeline.mjs -> runMergeTrial) executes a real nested merge trial. Remote
// compute shards lack nested confinement, so placing this file on a remote shard fails it on main.
// The local-only pattern must keep any file running that case on this machine.

test('unit:graphyard-e2e-serve-pinned — a test file running the delivery-pipeline case never goes to a remote shard', async () => {
  const text = await readFile(new URL('./graphyard-e2e-serve.test.ts', import.meta.url), 'utf8');
  assert.equal(remoteableTestFile(text), false);
});
