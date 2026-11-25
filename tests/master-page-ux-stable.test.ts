import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTests } from './helpers/run-tests.js';

// GY-3731: e2e:master-page-ux failed merge trials and batch gates on changes that never touched the
// Lead page: "Expected: ArrayContaining [...] Received: []" at the native-input step — no typed key
// reached the pane. The pane mounts hidden under the Conversation tab; when its hello lands before
// the spec switches to #master/live, its focus() finds a hidden element and the keys go to the page
// body. The spec now focuses the pane as a user does and waits for it. This proof runs the spec 20
// times on 4 workers; any failing run fails it.
test('unit:master-page-ux-stable — master-page-ux passes 20 of 20 runs on 4 workers', async () => {
  const finished = await runTests({ browser: true, args: ['--repeat-each=20', '--workers=4', 'browser-tests/master-page-ux.spec.ts'], stdio: 'pipe' });
  assert.equal(finished.code, 0, `a run of master-page-ux failed; 20 of 20 must pass:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
});

// GY-3813: on a loaded host the spec went offline between the reconnect's history and its live screen.
// Chromium holds a WebSocket frame that arrives offline and the dropped socket's close behind it, so
// the page never reconnected ("Expected: 2 Received: 1"). Here every live screen lands a second after
// its history, and the spec stays offline past that: it passes only by waiting for the screen first.
test('unit:master-page-ux-stable-pinned — master-page-ux passes when every live screen arrives well after its history', async () => {
  const finished = await runTests({ browser: true, args: ['--workers=1', '-g', 'e2e:master-page-ux', 'browser-tests/master-page-ux.spec.ts'], stdio: 'pipe', environment: { ...process.env, STUB_SCREEN_DELAY_MS: '1000' } });
  assert.equal(finished.code, 0, `master-page-ux failed with a late live screen:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
});
