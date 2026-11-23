import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';
import { hostShimDigest, hostShimScript } from '../src/host-shim.js';

// GY-3688 AC-1: one compute host serves two installs. The second install's prepare script appends its
// key beside the first's, binds it to the helper named by its own digest, and deletes no line it did
// not write; running it again changes nothing.

const proof = 'unit:host-prepare-adds-beside-other-installs';
const keyB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIInstallB install-b';
const digestB = 'b'.repeat(64);
const shimB = { script: hostShimScript.replace(hostShimDigest, digestB), digest: digestB };

test(`${proof} — a second install's prepare appends its key, bound to its own digest-named helper, and keeps the first's`, async () => {
  const hosts = await fakeHosts('host-prepare-adds-beside', [{ name: 'box' }]);
  const keys = join(hosts.home('box'), '.ssh', 'authorized_keys'), bin = join(hosts.host('box'), 'usr-local-bin');
  const first = await readFile(keys, 'utf8');
  const lineA = `restrict,command="graphyard-host-shim-${hostShimDigest}" ${hosts.publicKey}`;
  assert.equal(first, `${lineA}\n`);

  await hosts.prepare('box', { publicKey: keyB, shim: shimB });
  const lineB = `restrict,command="graphyard-host-shim-${digestB}" ${keyB}`;
  const second = await readFile(keys, 'utf8');
  assert.equal(second, `${first}${lineB}\n`, 'the second key is appended and no line is deleted');
  assert.deepEqual((await readdir(bin)).sort(), [`graphyard-host-shim-${digestB}`, `graphyard-host-shim-${hostShimDigest}`].sort(), 'each install keeps its own helper');
  assert.match(await readFile(join(bin, `graphyard-host-shim-${digestB}`), 'utf8'), new RegExp(`echo "shim ${digestB}"`));
  assert.match(await readFile(join(bin, `graphyard-host-shim-${hostShimDigest}`), 'utf8'), new RegExp(`echo "shim ${hostShimDigest}"`));

  await hosts.prepare('box', { publicKey: keyB, shim: shimB });
  assert.equal(await readFile(keys, 'utf8'), second, 'running the same script twice changes nothing');
  await hosts.prepare('box');
  assert.equal(await readFile(keys, 'utf8'), second, "re-running the first install's script changes nothing either");
});
