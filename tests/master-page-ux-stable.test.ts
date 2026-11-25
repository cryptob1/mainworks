import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ensureDashboardBuilt, runTests } from './helpers/run-tests.js';

// GY-3731: e2e:master-page-ux failed merge trials and batch gates on changes that never touched the
// Lead page: "Expected: ArrayContaining [...] Received: []" at the native-input step — no typed key
// reached the pane. The pane mounts hidden under the Conversation tab; when its hello lands before
// the spec switches to #master/live, its focus() finds a hidden element and the keys go to the page
// body. The spec now focuses the pane as a user does and waits for it. This proof runs the spec 20
// times across 10 workers; any failing run fails it.
test('unit:master-page-ux-stable — master-page-ux passes 20 of 20 runs on 10 workers', async () => {
  // Reuse the already-built dashboard bundle and skip the unused vite preview server (GY-3818).
  await ensureDashboardBuilt(process.cwd());
  const finished = await runTests({
    browser: true,
    args: ['--repeat-each=20', '--workers=10', 'browser-tests/master-page-ux.spec.ts'],
    environment: { ...process.env, GRAPHYARD_BROWSER_DIST: resolve('dist'), GRAPHYARD_PLAYWRIGHT_NO_WEBSERVER: '1' },
    stdio: 'pipe',
  });
  assert.equal(finished.code, 0, `a run of master-page-ux failed; 20 of 20 must pass:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
});
