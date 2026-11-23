import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTests } from './helpers/run-tests.js';

// GY-3723: browser-tests/item-why-and-simplest.spec.ts failed on the batch gate and passed its re-run. The
// create box selected the new item only after its refresh succeeded, so on a loaded host one failed read left
// the item filed but never opened, and the spec's wait for its page timed out. The item is now selected first.
test('unit:test-browser-tests-item-why-and-simplest-spec-ts-pinned — a new work item opens even when the refresh after its create fails once', async () => {
  const regression = await runTests({ browser: true, args: ['--config', 'tests/browser/playwright.config.ts', 'create-opens-after-failed-refresh'], stdio: 'pipe' });
  assert.equal(regression.code, 0, `${regression.stdout}\n${regression.stderr}`);
  assert.match(regression.stdout, /1 passed/);
});
