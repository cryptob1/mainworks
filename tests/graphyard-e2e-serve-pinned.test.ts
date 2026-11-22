import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';

// GY-3658: tests/graphyard-e2e-serve.test.ts runs unit:delivery-pipeline, which executes a real
// nested merge trial (scripts/e2e-delivery-pipeline.mjs -> runMergeTrial -> trialContainerWords)
// under bwrap (inside a trial container) or docker (outside one). Remote compute shards lack
// nested confinement, so placing this file on a remote shard fails it on main. It must stay on
// this machine.

test('unit:graphyard-e2e-serve-pinned — the e2e serve test runs a nested merge trial under bwrap/docker confinement, so it never goes to a remote shard', async () => {
  const text = await readFile(new URL('./graphyard-e2e-serve.test.ts', import.meta.url), 'utf8');
  assert.equal(remoteableTestFile(text), false);
});
