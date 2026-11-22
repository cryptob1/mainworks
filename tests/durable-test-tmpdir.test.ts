import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { durableTestTmpdir } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3624: a remote shard's container runs the suite with HOME=/tmp — itself a tmpfs, because the
// host shim names it the launcher's home (src/host-shim.ts) and the container's /tmp is a tmpfs.
// GY-2001's home-based replacement would be memory-backed there too, so every managed checkout the
// suite makes was refused ("is on a tmpfs"). The suite then takes the one durable writable place it
// holds: the run allocation beside the checkout, which the shim cloned into `<run>/repo`.

const tmpfs = 0x01021994, disk = 0x9123683e;

test('unit:durable-test-tmpdir — a memory-backed home takes the allocation beside the checkout, and nothing when that is volatile too', async () => {
  const home = await temporaryDirectory('durable-home'), beside = await temporaryDirectory('durable-beside');
  const volatile = new Set(['/tmp']);
  const reading = (path: string) => ({ type: volatile.has(path) ? tmpfs : disk });

  // A tmpdir on disk needs no replacement, and a durable home keeps GY-2001's own.
  assert.equal(durableTestTmpdir('/var/tmp', home, reading, beside), null);
  assert.equal(durableTestTmpdir('/tmp', home, reading, beside), join(home, '.gy', 'tmp'));

  // A memory-backed home names the run allocation beside the checkout instead, sticky and shared as /tmp is.
  volatile.add(home);
  assert.equal(durableTestTmpdir('/tmp', home, reading, beside), join(beside, 'tmp'));
  assert.equal((await stat(join(beside, 'tmp'))).mode & 0o1777, 0o1777, 'the replacement it makes is sticky and shared');

  // An allocation that is memory-backed all the way up leaves the caller where it was.
  volatile.add(join(beside, 'tmp'));
  assert.equal(durableTestTmpdir('/tmp', home, reading, beside), null);
});
