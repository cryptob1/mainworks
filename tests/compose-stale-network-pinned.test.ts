import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3933: tests/compose-stale-network.test.ts passed, then its file process died with SIGABRT
// (libuv: uv__close: Assertion `fd > STDERR_FILENO' failed). GY-3922's closed-stdin closed fd 0
// and reopened /dev/null after tsx had started, and a file tsx opened in that gap took fd 0, which
// libuv later closed and aborted on. The seam stands in for tsx: a NODE_OPTIONS preload (it runs
// before every command-line one) opens a file right after fd 0 closes whenever tsx is loaded.
// The per-file runner must give each file /dev/null on fd 0 without leaving that gap.
test('unit:compose-stale-network-pinned — a file the tsx loader opens cannot take fd 0 while the per-file runner swaps stdin for /dev/null', async () => {
  const directory = await temporaryDirectory('compose-stale-network-pinned');
  const loader = join(directory, 'loader.mjs'), file = join(directory, 'stdin.test.mjs');
  await writeFile(loader, `import fs from 'node:fs';
import Module from 'node:module';
const closeSync = fs.closeSync;
fs.closeSync = fd => { closeSync(fd); if (fd === 0 && Module._extensions['.ts']) fs.openSync(${JSON.stringify(loader)}, 'r'); };
Module.syncBuiltinESMExports();
`);
  await writeFile(file, `import test from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync, statSync } from 'node:fs';
test('fd 0 is /dev/null', () => {
  const stdin = fstatSync(0), devNull = statSync('/dev/null');
  assert.ok(stdin.isCharacterDevice() && stdin.rdev === devNull.rdev, 'a loader file took fd 0 between the close and the reopen');
});
`);
  const runner = new URL('./helpers/bounded-tests.mjs', import.meta.url).pathname;
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', runner, '--test-reporter=tap', '--test-reporter-destination=stdout', '--test-concurrency=1', '--file-timeout=60000', file], { encoding: 'utf8', env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import ${loader}`.trim() } }).catch(error => error);
  assert.match(stdout, /^ok 1 - fd 0 is \/dev\/null/m, stdout);
});
