import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3719: the batch gate failed browser-tests/dashboard-fun.spec.ts on 31badcea87cb and passed its re-run.
// The gate keeps no output, so the cause was read from a loaded re-run (40 repeats, 32 workers, host load ~60):
// only the empty-board test failed, every time at its 30 s default budget, still on "Verifying connection…" —
// sign-in alone took longer than that. Its siblings run the same sign-in with 60–90 s and passed. Every test
// in the spec now carries a budget that covers a loaded sign-in. This fails on the base, where one does not.
test('unit:test-browser-tests-dashboard-fun-spec-ts-pinned — every dashboard-fun test signs in with a budget of at least 60 s, not the 30 s default', () => {
  const spec = readFileSync(new URL('../browser-tests/dashboard-fun.spec.ts', import.meta.url), 'utf8');
  const bodies = spec.split(/\ntest\(/).slice(1);
  assert.ok(bodies.length >= 4, 'the spec still holds its tests');
  for (const body of bodies) {
    const name = body.slice(0, body.indexOf(',')), budget = body.match(/test\.setTimeout\(([\d_]+)\)/)?.[1];
    assert.ok(budget, `${name} sets its own budget`);
    assert.ok(Number(budget.replaceAll('_', '')) >= 60_000, `${name} allows at least 60 s for a loaded sign-in`);
  }
});
