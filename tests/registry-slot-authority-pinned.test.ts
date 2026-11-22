import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opensDashboard } from './helpers/run-tests.js';

// GY-3674: tests/registry-slot-authority.test.ts runs the dashboard E2E cases through the e2e
// runner against dist/. A remote shard's fresh checkout has no dist/, so the runner must build the
// dashboard for it, or the sign-in page never appears and work-item-detail times out.
const repo = new URL('..', import.meta.url).pathname;

test('unit:registry-slot-authority-pinned — a test file that runs E2E cases gets the dashboard built on a fresh shard checkout', () => {
  assert.equal(opensDashboard(repo, ['tests/registry-slot-authority.test.ts']), true);
});
