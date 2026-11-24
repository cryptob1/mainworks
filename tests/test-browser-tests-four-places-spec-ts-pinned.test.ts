import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERIFY_TIMEOUT_MS } from '../web/pages/login.js';

// GY-3796: the batch gate failed browser-tests/four-places.spec.ts on 9dd2b5cbd2bc and passed its re-run.
// Under load (20 repeats on 16 workers), 2 of 40 runs failed at line 90 still on "Verifying connection…":
// the spec waited 15 s for header.main-top-bar after sign-in while the page itself allows VERIFY_TIMEOUT_MS
// (30 s) for /api/status plus firstLoad, and the Test-cases fetch waited only the 5 s expect default.
// Both waits now allow loaded-host latency (VERIFY_TIMEOUT_MS for sign-in, 15 s for Test cases), inside
// the 120 s test budget. This test fails on the base.
test('unit:test-browser-tests-four-places-spec-ts-pinned — four-places waits for sign-in as long as the page allows it and allows loaded-host scenario loads', () => {
  const spec = readFileSync(new URL('../browser-tests/four-places.spec.ts', import.meta.url), 'utf8');
  assert.match(spec, /import \{ VERIFY_TIMEOUT_MS \} from '\.\.\/web\/pages\/login';/, 'the spec reads the page sign-in deadline');
  assert.match(spec, /locator\('header\.main-top-bar'\)\)\.toBeVisible\(\{ timeout: VERIFY_TIMEOUT_MS \}\)/, 'sign-in waits at least as long as VERIFY_TIMEOUT_MS');
  assert.match(spec, /locator\('\.scenario-card'\)\)\.toHaveCount\(1, \{ timeout: 15_000 \}\)/, 'the Test-cases fetch does not use the 5 s default');
  const budget = Number(spec.match(/test\.setTimeout\(([\d_]+)\)/)?.[1]?.replaceAll('_', ''));
  assert.ok(budget >= 2 * VERIFY_TIMEOUT_MS, 'the test budget covers sign-in and the rest of the test');
});
