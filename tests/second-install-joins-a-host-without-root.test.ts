import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { main } from '../src/cli/index.js';
import { hostShimDigest, hostShimScript, hostShimVerbs, trialVerbs } from '../src/host-shim.js';
import { addHost, probeHost, shareHost } from '../src/hosts.js';
import { readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { fakeHosts } from './helpers/fake-hosts.js';
import { dockerCreates, shardHosts, shardRepository } from './helpers/shard-hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3834 AC-2: a second install joins a host another install already prepared, with no root action:
// `host share HOST KEY` on the enrolled coordinator sends the key through the helper's share verb, which
// binds it to the same restricted helper with its own state directory; the second install's `host add`
// succeeds and its shards run there. A malformed key is refused; `host unshare` removes the line.

const proof = 'integration:second-install-joins-a-host-without-root';
const keyB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHTV6f52ARa/vlYRkS8yKc4Chbk2xf06bI6Tny1m2lZq install-b';
const blob = keyB.split(' ')[1]!;
const saved = { PATH: process.env.PATH, FAKE_SSH_KEY: process.env.FAKE_SSH_KEY, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME, GRAPHYARD_TRIAL_IMAGE: process.env.GRAPHYARD_TRIAL_IMAGE, [slotsDirectoryVariable]: process.env[slotsDirectoryVariable] };
let hosts: Awaited<ReturnType<typeof fakeHosts>>;
before(async () => {
  hosts = await fakeHosts('second-install-joins', [{ name: 'box' }]);
  Object.assign(process.env, { PATH: `${hosts.bin}:${saved.PATH}`, GRAPHYARD_CONFIG_HOME: join(hosts.root, 'config') });
});
after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

const as = async <T>(key: string | undefined, act: () => Promise<T>) => {
  if (key) process.env.FAKE_SSH_KEY = key; else delete process.env.FAKE_SSH_KEY;
  try { return await act(); } finally { delete process.env.FAKE_SSH_KEY; }
};
const output = async (argv: string[]) => {
  const lines: string[] = [], log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { await main(argv); } finally { console.log = log; }
  return lines.join('\n');
};

test(`${proof} — share binds the key to the same helper with its own state directory, the second install adds the host, a malformed key is refused and unshare removes the line`, async () => {
  const keys = join(hosts.home('box'), '.ssh', 'authorized_keys');
  assert.equal((await as(keyB, () => probeHost('gy-compute@box'))).ok, false, 'B has no access before share');

  assert.match(await output(['host', 'share', 'box', ...keyB.split(' ')]), /^Shared gy-compute@box with install-b: that install can now run mainworks host add gy-compute@box\.$/);
  const line = (await readFile(keys, 'utf8')).split('\n').find(entry => entry.includes(blob))!;
  assert.match(line, new RegExp(`^restrict,command="graphyard-host-shim-${hostShimDigest} --home ${join(hosts.home('box'), '.graphyard', 'installs')}/[0-9a-f]{12}" ssh-ed25519 ${blob.replace(/[+/]/g, '\\$&')} install-b$`), 'no shell, pty or forwarding; its own state directory');

  const b = await as(keyB, () => addHost('gy-compute@box', { file: join(hosts.root, 'b-hosts.json') }));
  assert.equal(b.added, true);
  assert.equal(b.probe?.shim, hostShimDigest, "B answers through A's helper");
  // A re-prepares at another helper release: the helper B's shared line names stays.
  await hosts.prepare('box', { shim: { script: hostShimScript.replace(hostShimDigest, 'c'.repeat(64)), digest: 'c'.repeat(64) } });
  assert.ok(existsSync(join(hosts.host('box'), 'usr-local-bin', `graphyard-host-shim-${hostShimDigest}`)), "the helper a shared key names is kept");
  assert.equal((await as(keyB, () => probeHost('gy-compute@box'))).ok, true, 'B still reaches the host');
  await hosts.prepare('box');

  const before = await readFile(keys, 'utf8');
  for (const bad of ['ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ x', `${keyB}\n${keyB}`, `command="sh" ${keyB}`, 'ssh-ed25519 AAAA', `${keyB} "quoted"`]) {
    await assert.rejects(shareHost('gy-compute@box', bad), /not one ssh-ed25519 public key line/, bad);
  }
  assert.equal(await readFile(keys, 'utf8'), before, 'a refused key changes nothing');

  assert.equal(await output(['host', 'unshare', 'gy-compute@box', ...keyB.split(' ')]), 'Unshared gy-compute@box from install-b.');
  assert.ok(!(await readFile(keys, 'utf8')).includes(blob), 'the line is gone');
  assert.equal((await as(keyB, () => probeHost('gy-compute@box'))).ok, false, 'B no longer reaches the host');
  assert.equal((await probeHost('gy-compute@box')).ok, true, 'A still does');

  // GY-3804: share adds verbs; every earlier revision stays.
  for (const verb of ['probe:1', 'receive-pack:1', 'receive-image:3', 'prepare-run:2', 'run-shard:2', 'fetch-records:1', 'clean:1', 'run-session:1', 'update-shim:1', 'share:1']) assert.ok(hostShimVerbs.includes(verb), verb);
  assert.ok(!trialVerbs.includes('share:1'), 'share is no trial verb: older hosts keep taking shards');
});

test(`${proof} — a shard run by the second install lands in its own state directory`, { timeout: 300_000 }, async () => {
  const image = 'mainworks-trial:second-install', target = 'gy-compute@box';
  const files = Array.from({ length: 2 }, (_, index) => `tests/plain-${index}.test.ts`);
  const shards = await shardHosts('second-install-shard', ['box'], { [image]: `sha256:${'3834'.repeat(16)}` });
  const repository = await shardRepository('second-install-shard-repo', files, Object.fromEntries(files.map(name => [name, 'test("adds", () => {})\n'])));
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  process.env[slotsDirectoryVariable] = join(shards.root, 'slots');
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${shards.bin}:${process.env.PATH}` }, ...(command === 'node' ? { wrapper: undefined } : {}) });
  };
  await shareHost(target, keyB, { run });
  const base = await temporaryDirectory('second-install-base');
  const result = await as(keyB, () => runTrial({ root: repository.root, base, mergeSha: repository.sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run, retries: 0,
    remote: { hosts: [target], read: async named => (await readShardHosts(named, run, 2)).map(reading => ({ ...reading, cores: reading.away ? 0 : 2, busy: 0, steal: 0, celsius: null })) } }));
  assert.equal(result.build, 'pass', result.logTail);
  assert.ok((await dockerCreates(shards.state('box'))).length > 0, 'the second install ran shards on the host');
  const installs = join(shards.home('box'), '.graphyard', 'installs');
  const [own] = existsSync(installs) ? await readdir(installs) : [];
  assert.ok(own && existsSync(join(installs, own, '.graphyard', 'mirrors')), "the second install's state lives in its own directory");
  assert.equal(existsSync(join(shards.home('box'), '.graphyard', 'mirrors')), false, "nothing in the first install's");
});
