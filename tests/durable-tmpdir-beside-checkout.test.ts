import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { durableTestTmpdir } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// A remote shard runs with HOME=/tmp, a tmpfs like its TMPDIR, so ~/.gy/tmp is memory-backed too and
// every managed checkout a test makes there is refused ("is on a tmpfs"). The run directory holding
// the checkout is on disk: the suite's temporary root goes beside the checkout instead.
test('unit:durable-tmpdir-beside-checkout — with TMPDIR and HOME both on a tmpfs, the suite tmpdir is on disk beside the checkout', async () => {
  const home = await temporaryDirectory('tmpfs-home'), run = await temporaryDirectory('run');
  const tmpfs = (path: string) => ({ type: path === '/memory' || path.startsWith(home) ? 0x01021994 : 0xef53 });
  assert.equal(durableTestTmpdir('/memory', home, tmpfs, join(run, 'repo')), join(run, 'tmp'));
  // A home on disk keeps the suite's usual root.
  assert.equal(durableTestTmpdir('/memory', run, () => ({ type: 0xef53 }), join(run, 'repo')), null);
  assert.equal(durableTestTmpdir('/memory', run, path => ({ type: path === '/memory' ? 0x01021994 : 0xef53 }), join(run, 'repo')), join(run, '.gy', 'tmp'));
});
