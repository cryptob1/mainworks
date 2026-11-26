import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, symlink, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';

// GY-3879 AC-2: the prepare script runs as root, but reads, writes, moves, downloads and runs everything
// under gy-compute's home as gy-compute. The stand-in host is the container: root's lines write anywhere,
// while what `sudo -u gy-compute` runs may write only that user's home (Landlock), as on a real host. With
// authorized_keys.new and every entry under ~/.graphyard/rootless planted as links to a root-owned file,
// running the generated script again leaves that file as it was, and either completes or stops with one line.

const proof = 'integration:prepare-never-writes-user-paths-as-root';
const keyB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHTV6f52ARa/vlYRkS8yKc4Chbk2xf06bI6Tny1m2lZq install-b';
const keyC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBm0e7y1Qw3cV2n8Zk4Lr6Tp9Xs5Hd1Fg7Jk3Mn2Pq8R install-c';

test(`${proof} — links planted in gy-compute's home never reach a root-owned file`, async () => {
  const hosts = await fakeHosts('prepare-as-user', [{ name: 'box', rootlessExtrasMissing: true, confineUser: true }]);
  const home = hosts.home('box'), rootOwned = join(hosts.host('box'), 'etc', 'ld.so.preload'), rootless = join(home, '.graphyard', 'rootless');
  await writeFile(rootOwned, 'root only\n');
  await chmod(rootOwned, 0o644);
  const before = await stat(rootOwned);
  await symlink(rootOwned, join(home, '.ssh', 'authorized_keys.new'));
  const entries = await readdir(rootless);
  assert.ok(entries.length > 0, 'the first prepare fetched the rootless extras into the home');
  for (const entry of entries) { await rm(join(rootless, entry), { recursive: true, force: true }); await symlink(rootOwned, join(rootless, entry)); }

  // Another install's key, so the script writes authorized_keys.new again; then once more with the extras
  // directory emptied, so the script downloads through the planted archive link.
  for (const [layout, key] of [['every entry a link', keyB], ['the archive a link', keyC]] as const) {
    if (layout === 'the archive a link') { await rm(join(rootless, 'docker-rootless-extras'), { force: true }); await mkdir(join(rootless, 'docker-rootless-extras')); }
    const outcome = await hosts.prepare('box', { publicKey: key }).then(() => 'completed', (error: Error) => error.message.replace(/^[^:]*: /, ''));
    if (outcome !== 'completed') assert.equal(outcome.trim().split('\n').length, 1, `${layout}: it stops with one line: ${outcome}`);
    const after = await stat(rootOwned);
    assert.equal(await readFile(rootOwned, 'utf8'), 'root only\n', `${layout}: the root-owned file keeps its content`);
    assert.equal(after.mode, before.mode, `${layout}: and its mode`);
    assert.equal(after.uid, before.uid, `${layout}: and its owner`);
    assert.ok((await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')).includes(key), `${layout}: the new key's line is in authorized_keys`);
  }
});
