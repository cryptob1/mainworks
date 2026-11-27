import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimScript, hostShimVerbs } from '../src/host-shim.js';
import { helperSigningKeyFile, readHostReadings, shareHost } from '../src/hosts.js';
import { fixtureShim, shardHosts, type ShardHostsFixture } from './helpers/shard-hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3879 AC-1: a key added with `host share` runs only the helper's trial verbs: update-shim, share and
// unshare are refused, and it cannot re-tag or remove a warm image another install loaded. The host's own
// key takes a helper update only when a key prepare recorded root-owned signed it; unshare never removes
// the host's own line. Every call drives the real helper script.

const proof = 'integration:shared-key-cannot-escape-the-helper';
const keyA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK8q6YQk2xPpQ0n3Wl1m8VbR0bNfH2s7x9uJtLqXw5aZ owner';
const keyB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHTV6f52ARa/vlYRkS8yKc4Chbk2xf06bI6Tny1m2lZq install-b';
const keyC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBm0e7y1Qw3cV2n8Zk4Lr6Tp9Xs5Hd1Fg7Jk3Mn2Pq8R install-c';
const target = 'gy-compute@box';
let hosts: ShardHostsFixture, keys: string, config: string;
const saved = process.env.GRAPHYARD_CONFIG_HOME;
before(async () => {
  hosts = await shardHosts('shared-key-escape', ['box'], {});
  config = await temporaryDirectory('shared-key-escape-config');
  process.env.GRAPHYARD_CONFIG_HOME = config;
  keys = join(hosts.home('box'), '.ssh', 'authorized_keys');
  await mkdir(join(hosts.home('box'), '.ssh'), { recursive: true });
  await writeFile(keys, `restrict,command="graphyard-host-shim" ${keyA}\n`);
  // What prepare records root-owned: this machine's signing key.
  await writeFile(hosts.shim, fixtureShim(hostShimScript, hosts.root));
});
after(() => { if (saved === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = saved; });

const run: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
/** One call through ssh as the install holding `key` (the owner's when absent). */
const call = (verb: string, input: string | Buffer, key?: string) => spawnSync(join(hosts.bin, 'ssh'), [target, verb], { input, encoding: 'utf8', env: { ...process.env, PATH: `${hosts.bin}:${process.env.PATH}`, ...(key ? { FAKE_SSH_KEY: key } : {}) } });
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const sign = (text: string, key = helperSigningKeyFile(config)) => execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', 'mainworks-helper'], { input: text, encoding: 'utf8' });
const tagged = (tag: string) => spawnSync(join(hosts.home('box'), '..', 'bin', 'docker'), ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).stdout.trim();
const shims = () => join(hosts.home('box'), '.graphyard', 'shims');

test(`${proof} — a shared key is refused update-shim, share and unshare of the owner's key with the helper's one-line refusal`, async () => {
  await shareHost(target, keyB, { run });
  const before = await readFile(keys, 'utf8');
  for (const [verb, input] of [[`update-shim ${sha(hostShimScript)}`, sign(hostShimScript) + hostShimScript], ['share', `${keyC}\n`], ['unshare', `${keyA}\n`]] as const) {
    const refused = call(verb, input, keyB);
    assert.equal(refused.status, 1, verb);
    assert.equal(refused.stderr, `graphyard-host-shim refuses: ${verb}\n`, verb);
  }
  assert.equal(await readFile(keys, 'utf8'), before, 'authorized_keys is unchanged');
  assert.equal(existsSync(join(hosts.home('box'), '.graphyard', 'installs')) && existsSync(shims()), false, 'no helper copy was written');
});

test(`${proof} — a shared key cannot re-tag or remove a warm image the owner's install loaded`, () => {
  const owners = 'graphyard-warm:aaaaaaaaaaaa-bbbbbbbbbbbb-cccccccccccc', older = 'graphyard-warm:aaaaaaaaaaaa-bbbbbbbbbbbb-dddddddddddd';
  for (const [tag, id] of [[older, '1'], [owners, '2']]) assert.equal(call(`receive-image ${tag}`, JSON.stringify({ name: tag, id: `sha256:${id.repeat(64)}` })).status, 0);
  const refused = call(`receive-image ${owners}`, JSON.stringify({ name: owners, id: `sha256:${'9'.repeat(64)}` }), keyB);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, `graphyard-host-shim refuses: receive-image ${owners}\n`);
  assert.equal(tagged(owners), `sha256:${'2'.repeat(64)}`, "the owner's tag still names its image");
  const own = 'graphyard-warm:111111111111-222222222222-333333333333';
  assert.equal(call(`receive-image ${own}`, JSON.stringify({ name: own, id: `sha256:${'7'.repeat(64)}` }), keyB).status, 0, 'its own tag loads');
  assert.equal(tagged(older), `sha256:${'1'.repeat(64)}`, "loading its own leaves the owner's older warm image");
  assert.equal(tagged(own), `sha256:${'7'.repeat(64)}`);
});

test(`${proof} — the owner's key takes only a signed helper update: a caller-chosen script is refused, a genuine update applies`, async () => {
  await rm(shims(), { recursive: true, force: true });
  const forged = '#!/bin/sh\nid > /tmp/owned\n';
  const other = join(await temporaryDirectory('shared-key-escape-other'), 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
  for (const input of [forged, sign(forged, other) + forged, sign(hostShimScript) + forged]) {
    const refused = call(`update-shim ${sha(forged)}`, input);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^graphyard-host-shim refuses the update: /);
  }
  assert.equal(existsSync(shims()), false, 'nothing was written');
  // An older helper on the host: the loop sends this release's, signed, and the host runs it.
  await writeFile(hosts.shim, fixtureShim(hostShimScript.replace(hostShimDigest, 'a'.repeat(64)).replace(' receive-image:4', ''), hosts.root));
  await writeFile(join(hosts.root, 'hosts.json'), JSON.stringify([{ target, addedAt: 'x' }]));
  const reading = (await readHostReadings([], { file: join(hosts.root, 'hosts.json'), run, local: 'here', update: true })).find(entry => entry.host === target)!;
  assert.equal(reading.away, false, reading.reason);
  assert.equal(reading.older, undefined, 'the genuine update applied');
  assert.match(call('probe', '').stdout, new RegExp(`^shim ${hostShimDigest}$`, 'm'));
  await writeFile(hosts.shim, fixtureShim(hostShimScript, hosts.root));
});

test(`${proof} — unshare by the owner's key removes only the shared line it names, never the owner's own`, async () => {
  assert.equal(call('unshare', `${keyA}\n`).status, 0);
  assert.equal(call('share', `${keyA}\n`).status, 1, "the owner's own key is not turned into a shared one");
  assert.ok((await readFile(keys, 'utf8')).includes(`restrict,command="graphyard-host-shim" ${keyA}`), "the owner's line stays");
  assert.equal(call('unshare', `${keyB}\n`).status, 0);
  const left = await readFile(keys, 'utf8');
  assert.ok(!left.includes(keyB.split(' ')[1]!), 'the shared line is gone');
  assert.ok(left.includes(keyA), "the owner's line stays");
  // GY-3804: the trial verbs keep every revision a coordinator speaks.
  for (const verb of ['probe:1', 'receive-pack:1', 'receive-image:3', 'prepare-run:2', 'run-shard:3', 'fetch-records:1', 'clean:1', 'run-session:1', 'share:1']) assert.ok(hostShimVerbs.includes(verb), verb);
});
