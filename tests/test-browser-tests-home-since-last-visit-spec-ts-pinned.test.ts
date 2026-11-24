import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERIFY_TIMEOUT_MS } from '../web/pages/login.js';

// GY-3797: the batch gate failed browser-tests/home-since-last-visit.spec.ts on 9dd2b5cbd2bc and
// passed its re-run. A loaded re-run (30 repeats, 20 workers) reproduced 12 failures — every one
// a 5 s default expect timeout inside visit(): waiting for header.main-top-bar after sign-in or
// waiting for the "Since you last looked" region after sign-in/reload and /api/home-visit, while
// the page itself allows VERIFY_TIMEOUT_MS (30 s) for sign-in and loading. Both waits in visit()
// and the Postgres-backed send confirmation now allow VERIFY_TIMEOUT_MS inside the 120 s budget.
test('unit:test-browser-tests-home-since-last-visit-spec-ts-pinned — home-since-last-visit waits for sign-in, reload and home-visit as long as the page allows', () => {
  const spec = readFileSync(new URL('../browser-tests/home-since-last-visit.spec.ts', import.meta.url), 'utf8');
  assert.match(spec, /import \{ VERIFY_TIMEOUT_MS \} from '\.\.\/web\/pages\/login';/, 'imports the page sign-in deadline');
  assert.match(spec, /locator\('header\.main-top-bar'\)\)\.toBeVisible\(\{ timeout: VERIFY_TIMEOUT_MS \}\)/, 'sign-in wait allows a full sign-in');
  assert.match(spec, /getByRole\('region', \{ name: 'Since you last looked' \}\)\)\.toBeVisible\(\{ timeout: VERIFY_TIMEOUT_MS \}\)/, 'home-visit wait allows a full sign-in and DB round-trip');
  assert.match(spec, /getByRole\('status'\)\)\.toHaveText\('Sent to the Lead\.', \{ timeout: VERIFY_TIMEOUT_MS \}\)/, 'send confirmation allows a loaded DB round-trip');
  const budget = Number(spec.match(/test\.setTimeout\(([\d_]+)\)/)?.[1]?.replaceAll('_', ''));
  assert.ok(budget >= 3 * VERIFY_TIMEOUT_MS, 'the test budget covers all three visits');
});
