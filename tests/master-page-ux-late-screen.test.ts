import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3813: the spec went offline between the reconnect's history and its live screen. Chromium holds
// a WebSocket frame that arrives while offline and the dropped socket's close behind it, so the page
// never reconnected ("Expected: 2 Received: 1"). This seam delays the live stream's opening screen
// past scrollback and delays the offline drop past that screen (idle sleeps, no CPU load), so an
// unawaited screen always lands while offline.
const lateScreen = `
const cp = require('node:child_process');
if (/herdr\\.cjs$/.test(process.argv[1] ?? '') && process.argv[2] === 'terminal') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
const fork = cp.fork;
cp.fork = (...args) => {
  const child = fork(...args), send = child.send.bind(child);
  let drops = 0;
  child.send = (message, ...rest) => message === 'drop-terminals' && ++drops === 2
    ? void setTimeout(() => { if (child.connected) send(message); }, 1200)
    : send(message, ...rest);
  return child;
};
require('node:module').syncBuiltinESMExports();
`;
test('unit:master-page-ux-stable-pinned — master-page-ux passes when a reconnect live screen arrives after its history', async () => {
  const preload = join(await temporaryDirectory('late-screen'), 'preload.cjs');
  await writeFile(preload, lateScreen);
  const finished = await runTests({ browser: true, args: ['--workers=1', '-g', 'e2e:master-page-ux', 'browser-tests/master-page-ux.spec.ts'], stdio: 'pipe', environment: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim() } });
  assert.equal(finished.code, 0, `master-page-ux failed with a late live screen:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
});
