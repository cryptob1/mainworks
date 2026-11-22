import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';

// GY-3619: the batch gate's affected run sharded tests/affected-after-back-merge.test.ts to a
// remote host, whose network-less shard could not fetch pnpm and turbo for the case's inner trial
// (its install runs through npm exec), so the file failed on every tip and held the release check.
// Like its siblings pnpm-workspace-trial and node-pin-trial, the file names the package-registry
// word, so the trial keeps it on this machine.

test('unit:affected-after-back-merge-pinned — the back-merge case names a local-only word (its inner trial installs a pnpm workspace through npm exec, and a remote shard has no network), so the trial never shards the file to a host', async () => {
  const text = await readFile(new URL('./affected-after-back-merge.test.ts', import.meta.url), 'utf8');
  assert.equal(remoteableTestFile(text), false, 'tests/affected-after-back-merge.test.ts stays on this machine: its inner trial fetches pnpm and turbo through npm exec, which a network-less remote shard cannot');
});
