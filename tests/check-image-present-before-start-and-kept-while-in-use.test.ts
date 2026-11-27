import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimVerbs, missingHelperVerbs } from '../src/host-shim.js';
import { remoteShardSession } from '../src/merge-writer/remote-shards.js';
import { freePort } from './helpers/http-server.js';
import { dockerCount, fixtureShim, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';
import { hostShimScript } from '../src/host-shim.js';

// GY-3952 AC-1: against the real helper script (Docker a stand-in that, like Docker, creates no container
// from an image the host lacks): after three base tips' warm images are uploaded in turn, a check on the
// first tag runs on every helper version the live machines run, re-sent where the helper dropped it; on this
// release's helper a tag a run named stays through later uploads, two installs' keys uploading in turn keep
// each other's images, and an image of the uploader's own family no run named for over an hour is pruned.

const proof = 'integration:check-image-present-before-start-and-kept-while-in-use';
const trialImage = 'mainworks-trial:gy-3952';
const tag = (lock: string, commit?: string) => `graphyard-warm:${'d'.repeat(12)}-${lock.repeat(12)}${commit ? `-${commit.repeat(12)}` : ''}`;
const tips = ['1', '2', '3'].map(commit => tag('a', commit));
const v1Tips = ['a', 'b', 'c'].map(lock => tag(lock));
const otherFamily = tag('e', '9');
const sharedTags = { x: ['4', '5', '6'].map(commit => tag('a', commit)), y: ['7', '8', '0'].map(commit => tag('a', commit)) };
const id = (name: string) => `sha256:${Buffer.from(name).toString('hex').padEnd(64, '0').slice(0, 64)}`;
// Probe of 2026-11-26: one machine on update-shim:2, receive-image:3 and run-shard:2, one on the oldest verb set.
const liveVerbs = {
  modern: 'probe:1 receive-pack:1 receive-image:3 prepare-run:2 run-shard:2 fetch-records:1 clean:1 run-session:1 update-shim:2 share:1',
  oldest: 'probe:1 receive-pack:1 receive-image:1 prepare-run:1 run-shard:2 fetch-records:1 clean:1',
};
const keyB = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'B'.repeat(43)} install-b`;

let hosts: ShardHostsFixture, repo: { root: string; sha: string }, port: number;
before(async () => {
  hosts = await shardHosts('gy-3952-hosts', ['current', 'modern', 'oldest', 'shared'],
    Object.fromEntries([trialImage, ...tips, ...v1Tips, otherFamily, ...sharedTags.x, ...sharedTags.y].map(name => [name, id(name)])));
  // The live machines' helpers: their verbs line, and (at worst) every older image of the family gone on each upload.
  for (const name of ['modern', 'oldest'] as const) {
    const script = fixtureShim(hostShimScript, hosts.root)
      .replace(/^ {4}echo "shim [0-9a-f]{64}"$/m, `    echo "shim ${(name === 'modern' ? 'a' : 'b').repeat(64)}"`)
      .replace(/^ {4}echo "verbs .*"$/m, `    echo "verbs ${liveVerbs[name]}"`)
      .replace("<= set(request) <= {'files', 'argv', 'cpus', 'deadline', 'nonce'}", '== set(request)')
      .replace('< 3600:', '< 0:');
    await writeFile(join(hosts.root, `shim-${name}`), script); await chmod(join(hosts.root, `shim-${name}`), 0o755);
  }
  const ssh = await readFile(join(hosts.bin, 'ssh'), 'utf8');
  await writeFile(join(hosts.bin, 'ssh'), ssh.replace(/SSH_ORIGINAL_COMMAND="\$last" exec "([^"]+)"\n$/, (_, shim: string) =>
    `case "$host" in modern|oldest) shim="${hosts.root}/shim-$host" ;; *) shim="${shim}" ;; esac\nSSH_ORIGINAL_COMMAND="$last" exec "$shim"\n`));
  port = await freePort();
  repo = await shardRepository('gy-3952-repo', [], { 'compose.json': JSON.stringify({ services: { db: { image: 'postgres:fixture', expose: [port] } } }) });
});

const run: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
/** The coordinator's upload, as warmCommitOnHosts sends it; `key` acts as another install. */
const upload = (host: string, image: string, key?: string) => run('sh', ['-c', `set -o pipefail 2>/dev/null; docker save '${image}' | ssh gy-compute@${host} 'receive-image ${image}'`],
  { timeoutMs: 30_000, ...(key ? { env: { FAKE_SSH_KEY: key } } : {}) });
const held = (host: string) => Object.keys((JSON.parse(readFileSync(join(hosts.state(host), 'state.json'), 'utf8')) as { images: Record<string, string> }).images);
const session = (host: string, image: string, verbs: readonly string[]) =>
  remoteShardSession({ root: repo.root, sha: repo.sha, image: trialImage, run, deadline: Date.now() + 60_000, hosts: [{ name: `gy-compute@${host}`, verbs: [...verbs] }], warm: async () => image });
const check = async (host: string, image: string, verbs: readonly string[]) => {
  const started = session(host, image, verbs);
  try { return await started.check(`gy-compute@${host}`, { file: 'compose.json', services: [{ service: 'db', port }], argv: ['true'], cpus: 1 }); }
  finally { await started.close(); }
};

test(`${proof} — after three base tips are uploaded, a check on the first tag runs on every live helper version, re-sent where it was dropped`, { timeout: 120_000 }, async () => {
  for (const [host, verbs, images] of [['current', hostShimVerbs, tips], ['modern', liveVerbs.modern.split(' '), tips], ['oldest', liveVerbs.oldest.split(' '), v1Tips]] as const) {
    for (const image of images) await upload(host, image);
    const end = await check(host, images[0], verbs);
    assert.equal(end.status, 0, `${host}: ${end.out}`);
    assert.doesNotMatch(end.out, /Unable to find image/, host);
    assert.ok(held(host).includes(images[0]), `${host} holds the tag it ran`);
    if (host === 'current') assert.equal(dockerCount(hosts.state(host), 'load'), 3, 'this release keeps the first tag: nothing is re-sent');
    else assert.equal(dockerCount(hosts.state(host), 'load'), 4, `${host} dropped the first tag and the check re-sent it`);
    // AC-2: the coordinator replaces each live helper, which lacks receive-image:4.
    if (host !== 'current') assert.ok(missingHelperVerbs({ shim: null, verbs: [...verbs] }).includes('receive-image:4'), host);
  }

  // A check prepared on a tag before newer tips arrive still finds it when it starts.
  const prepared = session('current', tips[0]!, hostShimVerbs);
  try {
    await prepared.ready('gy-compute@current');
    for (const image of [tag('a', '7'), tag('a', '8'), otherFamily]) await upload('current', image);
    const end = await prepared.check('gy-compute@current', { file: 'compose.json', services: [{ service: 'db', port }], argv: ['true'], cpus: 1 });
    assert.equal(end.status, 0, end.out);
  } finally { await prepared.close(); }
  assert.ok(held('current').includes(tips[0]!), 'a tag a run named within the hour is kept');
});

test(`${proof} — two installs' keys upload in turn and neither loses its image; an own-family tag unused for over an hour is pruned`, { timeout: 120_000 }, async () => {
  const share = await run('sh', ['-c', `printf '%s\\n' '${keyB}' | ssh gy-compute@shared share`], { timeoutMs: 30_000 });
  assert.equal(String(share).trim(), '');
  for (let index = 0; index < 2; index++) { await upload('shared', sharedTags.x[index]!); await upload('shared', sharedTags.y[index]!, keyB); }
  for (const image of [...sharedTags.x.slice(0, 2), ...sharedTags.y.slice(0, 2)]) assert.ok(held('shared').includes(image), `${image} survives the other install's uploads`);

  // Every marker an hour and more old, then a run names the second tag of install A.
  const home = hosts.home('shared'), stale = new Date(Date.now() - 2 * 3_600_000);
  const markerDirs = [join(home, '.graphyard', 'images'), join(home, '.graphyard', 'warm-named'), ...readdirSync(join(home, '.graphyard', 'installs')).map(name => join(home, '.graphyard', 'installs', name, '.graphyard', 'images'))];
  for (const dir of markerDirs) for (const name of readdirSync(dir)) utimesSync(join(dir, name), stale, stale);
  const named = session('shared', sharedTags.x[1]!, hostShimVerbs);
  try { await named.ready('gy-compute@shared'); } finally { await named.close(); }

  await upload('shared', sharedTags.x[2]!);
  assert.ok(!held('shared').includes(sharedTags.x[0]!), "install A's own tag unused for over an hour is pruned");
  assert.ok(held('shared').includes(sharedTags.x[1]!), 'the tag a run named within the hour is kept');
  for (const image of sharedTags.y.slice(0, 2)) assert.ok(held('shared').includes(image), `install A never removes ${image}, which install B loaded`);

  await upload('shared', sharedTags.y[2]!, keyB);
  for (const image of sharedTags.y.slice(0, 2)) assert.ok(!held('shared').includes(image), `install B prunes its own stale ${image}`);
  for (const image of sharedTags.x.slice(1)) assert.ok(held('shared').includes(image), `install B never removes ${image}, which install A loaded`);
});
