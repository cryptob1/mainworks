import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3468: browser-tests/dashboard.spec.ts failed on the batch gate and passed its re-run. Its connection-loss
// test waited out the dashboard's real 5 s poll three times (offline, back online, revoked), so under load it
// spent 20-27 s of its 30 s budget and failed 6 of 48 runs. It now jumps the page clock past the poll interval
// after each change, and each wait for the resulting read allows the settled 15 s.
test('unit:test-browser-tests-dashboard-spec-ts-pinned — the connection-loss test advances the page clock to each poll instead of waiting it out', () => {
  const spec = readFileSync(join(process.cwd(), 'browser-tests/dashboard.spec.ts'), 'utf8');
  assert.match(spec, /const nextPoll = \(page: Page\) => page\.clock\.runFor\(5000\), settled = \{ timeout: 15_000 \};/);
  const body = spec.split("test('connection loss labels stale data, recovers, and revoked sessions clear the dashboard'")[1]?.split('\n});')[0] ?? '';
  assert.match(body, /^, async \(\{ page \}\) => \{\n  await page\.clock\.install\(\);\n/, 'the clock is installed before the page loads');
  for (const change of ['state.offline = true', 'state.offline = false', 'state.unauthorized = true']) {
    assert.ok(body.includes(`${change}; await nextPoll(page);\n  await expect(`), `${change} is followed by the next poll`);
  }
  const waits = body.match(/\{ timeout: \d+ \}|settled\)/g) ?? [];
  assert.ok(waits.length >= 4 && waits.every(wait => wait === 'settled)'), 'every connection wait allows the settled time');
});

// GY-4066: this spec's four-state test failed in a merge trial on a loaded host and passed 630 times locally.
// Sign-in takes three answers from the runner's own route handlers (status, work-snapshot and board), and each
// test's first wait after it allowed the 5 s default. With every answer 2 s late, as GY-3442's trace measured
// on a loaded trial host, thirteen of the spec's tests failed that first wait; login() now waits for the
// dashboard itself with the settled 15 s, except where a test watches the sign-in.
test('unit:test-browser-tests-dashboard-spec-ts-pinned — sign-in waits for the dashboard with the settled time, except where a test watches the sign-in', () => {
  const spec = readFileSync(join(process.cwd(), 'browser-tests/dashboard.spec.ts'), 'utf8');
  assert.match(spec, /const live = \{ timeout: 15_000 \};/, 'the spec names the settled wait for a page load');
  assert.match(spec, /if \(dashboard\) await expect\(page\.locator\('header\.main-top-bar'\)\)\.toBeVisible\(live\);\n\}/, 'login ends by waiting for the dashboard');
  const watched = spec.match(/login\(page, '[^']*', \{ dashboard: false \}\)/g) ?? [];
  assert.equal(watched.length, 3, 'only the refused token and the two reads the tests hold open are watched by their tests');
  assert.equal((spec.match(/login\(page, (?!'[^']*', \{ dashboard: false \}\))[^)]*\)/g) ?? []).length, 0, 'a sign-in with a token of its own says it is watched');
});
