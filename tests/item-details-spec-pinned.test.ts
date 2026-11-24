import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERIFY_TIMEOUT_MS } from '../web/pages/login.js';

// GY-3798: the batch gate failed browser-tests/item-details.spec.ts on 9dd2b5cbd2bc and passed its re-run.
// Its sign-in waited the 5 s expect default for the Work heading while the page allows VERIFY_TIMEOUT_MS (30 s),
// and the test ran on Playwright's 30 s default budget. On a loaded gate host sign-in alone outlasts 5 s (same
// cause as GY-3719 / GY-3724). The spec now waits VERIFY_TIMEOUT_MS for sign-in inside a 2 * VERIFY_TIMEOUT_MS
// test budget. This fails on the base, where sign-in waits 5 s and the test carries no budget of its own.
test('unit:test-browser-tests-item-details-spec-ts-pinned — item-details waits for sign-in as long as the page allows it, inside its test budget', () => {
  const spec = readFileSync(new URL('../browser-tests/item-details.spec.ts', import.meta.url), 'utf8');
  assert.match(spec, /heading', \{ name: 'Work', exact: true \}\)\)\.toBeVisible\(\{ timeout: VERIFY_TIMEOUT_MS \}\)/, 'the sign-in wait allows the page\'s own sign-in deadline');
  const bodies = spec.split(/\ntest\(/).slice(1);
  assert.ok(bodies.length >= 1, 'the spec still holds its test');
  for (const body of bodies) {
    const name = body.slice(0, body.indexOf(',')), budget = body.match(/test\.setTimeout\(([^)]+)\)/)?.[1]?.trim();
    assert.ok(budget, `${name} sets its own budget`);
    const ms = budget === '2 * VERIFY_TIMEOUT_MS' ? 2 * VERIFY_TIMEOUT_MS : Number(budget.replaceAll('_', ''));
    assert.ok(ms >= 2 * VERIFY_TIMEOUT_MS, `${name} allows a full sign-in and the rest of the test`);
  }
});
