import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';
import { hostShimDigest, hostShimScript } from '../src/host-shim.js';
import { addHost, hostAddCommand, probeHost, readHostReadings } from '../src/hosts.js';
import { outdatedShimAttention } from '../src/merge-writer/remote-shards.js';
import { encodeLoopHosts, loopHosts } from '../src/model/loop-presence.js';

// GY-3688 AC-2: a fake host prepared for install A at this release's helper and install B at another
// answers each install's probe through its own helper, and both installs' `host add` checks pass.
// Removing install B's key leaves A working, and A's next prepare removes the helper no key names.

const proof = 'integration:two-installs-share-a-host';
const keyB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIInstallB install-b';
const digestB = 'b'.repeat(64);
let hosts: Awaited<ReturnType<typeof fakeHosts>>;
const saved = { PATH: process.env.PATH, FAKE_SSH_KEY: process.env.FAKE_SSH_KEY };

before(async () => {
  hosts = await fakeHosts('two-installs-share-a-host', [{ name: 'box' }]);
  await hosts.prepare('box', { publicKey: keyB, shim: { script: hostShimScript.replace(hostShimDigest, digestB), digest: digestB } });
  process.env.PATH = `${hosts.bin}:${saved.PATH}`;
});
after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

/** Act as one install: its own key reaches the host, its own hosts file records it. */
const as = async <T>(key: string | undefined, act: () => Promise<T>) => {
  if (key) process.env.FAKE_SSH_KEY = key; else delete process.env.FAKE_SSH_KEY;
  try { return await act(); } finally { delete process.env.FAKE_SSH_KEY; }
};

test(`${proof} — each install's probe answers through its own helper, both host add checks pass, and removing B's key leaves A working`, async () => {
  const a = await as(undefined, () => probeHost('gy-compute@box'));
  const b = await as(keyB, () => probeHost('gy-compute@box'));
  assert.ok(a.ok && b.ok, `both ready: ${JSON.stringify({ a, b })}`);
  assert.equal(a.ok && a.shim, hostShimDigest, "A's probe answers through A's helper");
  assert.equal(b.ok && b.shim, digestB, "B's probe answers through B's helper");
  assert.equal((await as(undefined, () => addHost('gy-compute@box', { file: join(hosts.root, 'a-hosts.json') }))).added, true);
  assert.equal((await as(keyB, () => addHost('gy-compute@box', { file: join(hosts.root, 'b-hosts.json') }))).added, true);

  // GY-3744: master status names B's host as on an older helper in one line; the host stays ready. A's reads nothing.
  const readings = async (key: string | undefined, file: string) => loopHosts(encodeLoopHosts(await as(key, () => readHostReadings([], { file, local: 'here' }))))!;
  const older = await readings(keyB, join(hosts.root, 'b-hosts.json'));
  assert.equal(older.find(reading => reading.host === 'gy-compute@box')!.away, false, "B's host stays ready");
  assert.deepEqual(outdatedShimAttention(older).map(line => line.text), [`gy-compute@box runs an older helper: run ${hostAddCommand('gy-compute@box')} to update it`]);
  assert.deepEqual(outdatedShimAttention(await readings(undefined, join(hosts.root, 'a-hosts.json'))), [], "A's host runs this release's helper");

  const keys = join(hosts.home('box'), '.ssh', 'authorized_keys');
  await writeFile(keys, (await readFile(keys, 'utf8')).split('\n').filter(line => !line.includes(keyB)).join('\n'));
  assert.equal((await as(keyB, () => probeHost('gy-compute@box'))).ok, false, "B's key no longer reaches the host");
  const again = await as(undefined, () => probeHost('gy-compute@box'));
  assert.equal(again.ok && again.shim, hostShimDigest, 'A still answers through its own helper');
  await hosts.prepare('box');
  assert.deepEqual(await readdir(join(hosts.host('box'), 'usr-local-bin')), [`graphyard-host-shim-${hostShimDigest}`], "A's prepare removes the helper no key names");
  const after = await as(undefined, () => probeHost('gy-compute@box'));
  assert.equal(after.ok && after.shim, hostShimDigest);
});
