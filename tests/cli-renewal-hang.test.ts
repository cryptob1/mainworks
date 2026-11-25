import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3828: `supervisor stops a worker when renewal hangs beyond the granted lease` in tests/cli.test.ts
// ran a 200 ms lease against real wall-clock timers while spawning a real Node subprocess, leaving only
// ~75 ms of slack before the retry window closed. Any spawn or timer delay past that slack skipped the
// retry window and failed `assert.equal(count, 3)`. This seam injects a 130 ms idle sleep on the worker
// spawn (no CPU load, no lengthened timeout) so the first interval tick lands past the 150 ms retry window
// on every run of the base tip.
const slowWorkerSpawn = `
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = (command, args, ...rest) => {
  if (Array.isArray(args) && args.some(arg => typeof arg === 'string' && arg.includes("process.on('SIGTERM'"))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 130);
  }
  return spawn.call(cp, command, args, ...rest);
};
require('node:module').syncBuiltinESMExports();
`;

test('unit:cli-pinned — renewal-hang supervisor test passes deterministically when worker spawn is delayed', async () => {
  const preload = join(await temporaryDirectory('cli-renewal-hang'), 'preload.cjs');
  await writeFile(preload, slowWorkerSpawn);
  const finished = await runTests({
    args: ['--test-name-pattern=supervisor stops a worker when renewal hangs beyond the granted lease', 'tests/cli.test.ts'],
    stdio: 'pipe',
    environment: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim() },
  });
  assert.equal(finished.code, 0, `tests/cli.test.ts failed with a delayed worker spawn:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
});
