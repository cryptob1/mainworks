import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runTests } from './helpers/run-tests.js';

// GY-3997: browser-tests/expiry-loop-stop.spec.ts failed on the batch gate at 85aefcd23311 and passed its re-run.
// Its page reaches the control plane through a route that fetched each API request once and aborted it on any
// network error. A connection reset on the sign-in redemption (a keep-alive connection the server had just closed)
// therefore failed the sign-in itself, which the page does not retry, so the Work heading never came. The route now
// retries a reset once. The seam drops the connection of the first sign-in the test's server receives.
test('unit:test-browser-tests-expiry-loop-stop-spec-ts-pinned — a reset connection on sign-in is retried, so the page still opens on Work', async () => {
  const seam = fileURLToPath(new URL('fixtures/reset-first-sign-in.mjs', import.meta.url));
  const environment = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${seam}`.trim() };
  const suite = await runTests({ browser: true, args: ['browser-tests/expiry-loop-stop.spec.ts', '--workers=1', '--reporter=line'], environment, stdio: 'pipe' });
  assert.equal(suite.code, 0, `${suite.stdout}\n${suite.stderr}`);
  assert.match(suite.stdout, /1 passed/);
});
