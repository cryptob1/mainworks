import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTests } from './helpers/run-tests.js';

// GY-3998: browser-tests/workers-page-live-session.spec.ts failed on the batch gate at 85aefcd23311 (a toBeVisible)
// and passed its re-run. When the watched run ended, its view said so from its own 2 s log read, but the row moved to
// Ended only on the dashboard's next 5 s background poll, and the spec gave that move 5 s. The page now re-reads the
// moment a watched run ends. The seam (WORKERS_PAGE_HOLD_POLL) leaves every background poll after the end unanswered,
// so the row reaches Ended only through the read the end itself prompts.
test('unit:test-browser-tests-workers-page-live-session-spec-ts-pinned — a watched run that ends moves to Ended without waiting for the next background poll', async () => {
  const environment = { ...process.env, WORKERS_PAGE_HOLD_POLL: '1' };
  const suite = await runTests({ browser: true, args: ['browser-tests/workers-page-live-session.spec.ts', '--workers=1', '--reporter=line'], environment, stdio: 'pipe' });
  assert.equal(suite.code, 0, `${suite.stdout}\n${suite.stderr}`);
  assert.match(suite.stdout, /1 passed/);
});
