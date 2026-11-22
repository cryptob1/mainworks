import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';

// GY-3628: tests/node-pin-trial.test.ts fetches pnpm and a pinned node from the npm registry. A remote
// shard has no network, so placed there it failed with EAI_AGAIN and the batch gate filed it known red.
// It must stay on this machine, which has registry access.

test('unit:node-pin-trial-pinned — the node-pin trial test, which fetches from the npm registry, never goes to a remote shard', async () => {
  const text = await readFile(new URL('./node-pin-trial.test.ts', import.meta.url), 'utf8');
  assert.equal(remoteableTestFile(text), false);
});
