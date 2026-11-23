import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERIFY_TIMEOUT_MS } from '../web/pages/login.js';

// GY-3719: the batch gate failed browser-tests/dashboard-fun.spec.ts on 31badcea87cb and passed its re-run.
// The gate keeps no output, so the cause was read from a loaded re-run (40 repeats, 32 workers, host load ~60):
// tests failed still on "Verifying connection…": the sign-in helper waited the 5 s expect default for the Work
// heading, while the page itself gives sign-in VERIFY_TIMEOUT_MS (30 s), and the empty-board test ran on the 30 s
// default test budget. The helper now waits as long as the page allows, and every test carries a budget past it.
// This fails on the base, where the helper waits 5 s and the empty-board test has no budget of its own.
test('unit:test-browser-tests-dashboard-fun-spec-ts-pinned — dashboard-fun waits for sign-in as long as the page allows it, inside every test\'s budget', () => {
  const spec = readFileSync(new URL('../browser-tests/dashboard-fun.spec.ts', import.meta.url), 'utf8');
  assert.match(spec, /heading', \{ name: 'Work', exact: true, level: 1 \}\)\)\.toBeVisible\(\{ timeout: VERIFY_TIMEOUT_MS \}\)/, 'the sign-in helper waits up to the page\'s own sign-in deadline');
  const bodies = spec.split(/\ntest\(/).slice(1);
  assert.ok(bodies.length >= 4, 'the spec still holds its tests');
  for (const body of bodies) {
    const name = body.slice(0, body.indexOf(',')), budget = body.match(/test\.setTimeout\(([\d_]+)\)/)?.[1];
    assert.ok(budget, `${name} sets its own budget`);
    assert.ok(Number(budget.replaceAll('_', '')) >= 2 * VERIFY_TIMEOUT_MS, `${name} allows a full sign-in and the rest of the test`);
  }
});
