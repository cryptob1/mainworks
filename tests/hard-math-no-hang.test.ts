import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3922: GY-3914's e2e trial script reads its nonce with readFileSync(0). The hard-math fixture
// ran it inside the test file, whose stdin under the merge trial's runner is a socket Node's test
// runner never closes, so the read blocked the event loop until the 300 s file bound killed the file.
test('unit:hard-math-no-hang — a test file run by the merge trial\'s per-file runner reads end of input from stdin', async () => {
  const directory = await temporaryDirectory('hard-math-no-hang');
  const file = join(directory, 'stdin.test.mjs');
  await writeFile(file, `import test from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync, readFileSync } from 'node:fs';
test('stdin is at end of input', () => {
  const stdin = fstatSync(0);
  assert.ok(!stdin.isSocket() && !stdin.isFIFO(), 'stdin is a pipe nobody closes, so a read waits for the file bound');
  assert.equal(readFileSync(0, 'utf8'), '');
});
`);
  const runner = new URL('./helpers/bounded-tests.mjs', import.meta.url).pathname;
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', runner, '--test-reporter=tap', '--test-reporter-destination=stdout', '--test-concurrency=1', '--file-timeout=60000', file], { encoding: 'utf8', env }).catch(error => error);
  assert.match(stdout, /^ok 1 - stdin is at end of input/m, stdout);
});
