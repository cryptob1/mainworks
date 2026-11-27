import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERIFY_TIMEOUT_MS } from '../web/pages/login.js';

// GY-3724: the batch gate failed browser-tests/real-app-onboarding.spec.ts on e54fe364d944 and passed its re-run,
// in the same loaded run where its sibling browser specs flaked (GY-3719/3720/3723). The Setup item's text comes
// from /api/status, read after the sign-in link is verified, and again after the reload; both waits used the 5 s
// expect default while the page itself allows sign-in and that reply VERIFY_TIMEOUT_MS (30 s). A /api/status reply
// held 6 s fails the base at the first wait. Both waits now allow what the page allows. This fails on the base.
test('unit:test-browser-tests-real-app-onboarding-spec-ts-pinned — real-app-onboarding waits for the status reply as long as the page allows it', () => {
  const spec = readFileSync(new URL('../browser-tests/real-app-onboarding.spec.ts', import.meta.url), 'utf8');
  assert.match(spec, /toContainText\('owner\/Lumina is not onboarded yet', \{ timeout: VERIFY_TIMEOUT_MS \}\)/, 'the first status-backed wait allows a full sign-in');
  assert.match(spec, /toContainText\('Project onboarded', \{ timeout: VERIFY_TIMEOUT_MS \}\)/, 'the wait after the reload allows a full sign-in');
  const budget = Number(spec.match(/test\.setTimeout\(([\d_]+)\)/)?.[1]?.replaceAll('_', ''));
  assert.ok(budget >= 2 * VERIFY_TIMEOUT_MS, 'the test budget covers both waits');
});
