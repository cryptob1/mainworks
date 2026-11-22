import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';

// GY-3604: a remote shard runs with no network, so a test whose trial installs from the npm registry
// (pnpm and node fetched through npm exec into the host's npm cache) failed there as "could not fetch
// from npm" — a red verdict on main that measured only the host. Such a file stays on this machine.

const repo = new URL('..', import.meta.url).pathname;

test('unit:pnpm-workspace-trial-pinned — test files whose trials fetch from the npm registry are local-only, so no remote shard runs them without a network', async () => {
  for (const file of ['tests/pnpm-workspace-trial.test.ts', 'tests/node-pin-trial.test.ts', 'tests/affected-after-back-merge.test.ts'])
    assert.equal(remoteableTestFile(await readFile(`${repo}${file}`, 'utf8')), false, `${file} stays on this machine`);
});
