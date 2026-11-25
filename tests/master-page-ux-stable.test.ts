import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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
// the page never reconnected ("Expected: 2 Received: 1"). The preload makes that host certain: every
// live stream starts a second and a half after its history, and every drop waits three seconds, so a
// screen the spec did not wait for lands while it is offline.
const loadedHost = `
const cp = require('node:child_process');
if (/herdr\\.cjs$/.test(process.argv[1] ?? '') && process.argv[2] === 'terminal') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
const fork = cp.fork;
cp.fork = (...args) => {
  const child = fork(...args), send = child.send.bind(child);
  child.send = (message, ...rest) => message === 'drop-terminals' ? void setTimeout(() => { if (child.connected) send(message); }, 3000) : send(message, ...rest);
  return child;
};
require('node:module').syncBuiltinESMExports();
`;
test('unit:master-page-ux-stable-pinned — master-page-ux passes when every live screen arrives well after its history', async () => {
  const preload = join(await temporaryDirectory('loaded-host'), 'preload.cjs');
  await writeFile(preload, loadedHost);
  const finished = await runTests({ browser: true, args: ['--workers=1', '-g', 'e2e:master-page-ux', 'browser-tests/master-page-ux.spec.ts'], stdio: 'pipe', environment: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim() } });
  assert.equal(finished.code, 0, `master-page-ux failed with a late live screen:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
});
