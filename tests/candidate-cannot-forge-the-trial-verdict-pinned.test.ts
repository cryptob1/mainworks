import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3931: tests/candidate-cannot-forge-the-trial-verdict.test.ts aborted on exit with
// `uv__close: Assertion 'fd > STDERR_FILENO' failed` (SIGABRT) under bounded-tests.mjs.
// GY-3922's closed-stdin.mjs called closeSync(0) followed by openSync('/dev/null', 'r'); any
// concurrent operation that opens a libuv handle in that window receives fd 0 and aborts libuv
// when closed. Injecting a libuv spawn immediately after closeSync(0) reproduces the race on every
// run of the base tip without loading the host or lengthening any wait.
test('unit:candidate-cannot-forge-the-trial-verdict-pinned — bounded-tests never closes fd 0 in userland, so no concurrent libuv handle can claim fd 0 and abort on uv__close', async () => {
  const directory = await temporaryDirectory('verdict-pinned-fd0');
  const hook = join(directory, 'race-fd0.mjs');
  const probe = join(directory, 'probe.test.mjs');
  await writeFile(hook, `import { createRequire, syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
const fs = createRequire(import.meta.url)('node:fs');
const closeSync = fs.closeSync;
fs.closeSync = function (fd, ...rest) {
  const result = closeSync.call(this, fd, ...rest);
  if (fd === 0) execFileSync('true');
  return result;
};
syncBuiltinESMExports();
`);
  await writeFile(probe, `import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fstatSync, readFileSync } from 'node:fs';
test('stdin is /dev/null without closing fd 0', () => {
  const stdin = fstatSync(0);
  assert.ok(!stdin.isSocket() && !stdin.isFIFO(), 'stdin must not be an unclosed socket or pipe');
  assert.equal(readFileSync(0, 'utf8'), '');
  execFileSync('true');
});
`);
  const runner = new URL('./helpers/bounded-tests.mjs', import.meta.url).pathname;
  const { NODE_TEST_CONTEXT: _context, NODE_OPTIONS: existing, ...rest } = process.env;
  const importHook = `--import=${pathToFileURL(hook).href}`;
  const env = { ...rest, NODE_OPTIONS: existing ? `${existing} ${importHook}` : importHook };
  const result = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', runner, '--test-reporter=tap', '--test-reporter-destination=stdout', '--test-concurrency=1', '--file-timeout=60000', probe],
    { encoding: 'utf8', env },
  ).catch(error => error as { stdout?: string; stderr?: string; code?: number; signal?: string });
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.doesNotMatch(combined, /uv__close|SIGABRT/, combined);
  assert.match(result.stdout ?? '', /^ok 1 - stdin is \/dev\/null without closing fd 0/m, combined);
  assert.equal('code' in result ? result.code : 0, 0, combined);
});
