import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { funnelCommand, funnelRetryMs, servedUrl } from '../src/team-access.js';
import { fakeTailscale, onPath } from './helpers/fake-tailscale.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3690: the loop keeps an install's public link on: Funnel goes back on for the public port that
// already serves the install, else the first free one, never one serving anything else, at most every 10 minutes.

const host = 'yard.tail-test.ts.net';
const web = (ports: Record<string, string>) => ({
  TCP: Object.fromEntries(Object.keys(ports).map(port => [port, { HTTPS: true }])),
  Web: Object.fromEntries(Object.entries(ports).map(([port, proxy]) => [`${host}:${port}`, { Handlers: { '/': { Proxy: proxy } } }])),
});

test('unit:funnel-is-restored-on-the-port-that-serves-the-install — the port proxying this install tailnet-only gets Funnel, else the first free one, never another target\'s; the command runs at most once per 10 minutes', async () => {
  const install = 'http://127.0.0.1:4310', terminal = 'http://127.0.0.1:7681';
  const funnel = (port: string) => ['tailscale', 'funnel', '--bg', `--https=${port}`, install];
  assert.deepEqual(funnelCommand('4310', web({ 443: install })), funnel('443'), '443 serves this install tailnet-only');
  assert.deepEqual(funnelCommand('4310', web({ 443: terminal, 10000: install })), funnel('10000'), '443 serves something else; 10000 serves this install');
  assert.deepEqual(funnelCommand('4310', web({ 443: terminal })), funnel('8443'), 'no mapping for the install: the first free funnel port');
  assert.equal(funnelCommand('4310', web({ 443: terminal, 8443: terminal, 10000: terminal })), null, 'a port proxying another target never gets Funnel');

  // The check runs every pass; the command runs at most once per 10 minutes while the link is not public.
  const dir = await temporaryDirectory('funnel-restore');
  writeFileSync(join(dir, 'served-https.json'), JSON.stringify({ 10000: install, 443: terminal }));
  writeFileSync(join(dir, 'funnel-refused'), '');
  const restore = onPath(await fakeTailscale(dir));
  try {
    const funnels = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).filter(args => args[0] === 'funnel');
    const start = 1_000_000;
    const first = await servedUrl('4310', start);
    assert.deepEqual(funnels(), [funnel('10000').slice(1)]);
    assert.equal(first.public, false);
    assert.match(first.doing!, /^Turning Funnel on for port 10000 failed: .*The loop retries every 10 minutes\.$/);
    await servedUrl('4310', start + funnelRetryMs - 1);
    assert.equal(funnels().length, 1, 'not again within 10 minutes');
    const reads = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').length;
    assert.ok(reads >= 3, 'the serve status is still read every pass');
    await servedUrl('4310', start + funnelRetryMs);
    assert.equal(funnels().length, 2, 'again after 10 minutes');
    writeFileSync(join(dir, 'funnel.json'), JSON.stringify({ 10000: true }));
    const on = await servedUrl('4310', start + 3 * funnelRetryMs);
    assert.deepEqual([on.public, on.doing, funnels().length], [true, null, 2]);
  } finally { restore(); }
});
