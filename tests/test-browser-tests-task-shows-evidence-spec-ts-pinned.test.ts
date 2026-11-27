import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runTests } from './helpers/run-tests.js';

// GY-3975: browser-tests/task-shows-evidence.spec.ts failed on the batch gate at abd2266bdbe2 and passed its re-run.
// Its fixture stamped every time once when the file loaded, while the mocked snapshot read the wall clock at
// each request: a worker that spent over a minute in the file saw each time in state ("2m", "12m", "41m") a minute
// late. The spec now reads the clock once and serves that instant as the snapshot's now. The seam makes every
// clock read in the Playwright worker a minute later than the last, so any second read of the clock shows.
test('unit:test-browser-tests-task-shows-evidence-spec-ts-pinned — the Task page fixture reads its clock once, so a slow worker sees the same times in state', async () => {
  const seam = fileURLToPath(new URL('fixtures/minute-per-clock-read.mjs', import.meta.url));
  const environment = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${seam}`.trim() };
  const suite = await runTests({ browser: true, args: ['browser-tests/task-shows-evidence.spec.ts', '--workers=1', '--reporter=line'], environment, stdio: 'pipe' });
  assert.equal(suite.code, 0, `${suite.stdout}\n${suite.stderr}`);
  assert.match(suite.stdout, /9 passed/);
});
