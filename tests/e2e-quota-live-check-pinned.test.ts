import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostableTrialCase, splitLocalOnlyTests } from '../src/merge-writer/remote-shards.js';

// The quoted-output case dynamically imports the real worker fixture. Its managed worktrees
// need durable storage; remote test containers give it memory-backed temporary storage.
test('unit:e2e-quota-live-check-pinned — the live worker quota check runs where its managed worktrees can be created', async () => {
  const root = join(import.meta.dirname, '..');
  const file = 'tests/quota-live-check.test.ts';
  const placement = await splitLocalOnlyTests([file], name => readFile(join(root, name), 'utf8'));
  assert.deepEqual(placement, { remoteable: [], localOnly: [file] }, 'the suite keeps the real worker fixture on durable storage');
  assert.equal(await hostableTrialCase(root, 'quota-live-check'), false, 'the E2E case keeps the same host requirement');
});
