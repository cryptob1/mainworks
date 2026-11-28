import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimScript, hostShimVerbs } from '../src/host-shim.js';
import { helperSigningKeyFile, readHostReadings } from '../src/hosts.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { outdatedShimAttention, readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { fakeHosts } from './helpers/fake-hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCreates, fixtureShim, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3780: after a release changes graphyard-host-shim the loop updates each host over its restricted
// key; nobody runs host prepare. A host that does not take the update reads away with the reason.

const proof = 'integration:host-shim-self-update';
const image = 'mainworks-trial:self-update', target = 'gy-compute@box';
const files = Array.from({ length: 4 }, (_, index) => `tests/plain-${index}.test.ts`);
let hosts: ShardHostsFixture, file: string, repository: { root: string; sha: string };
const previous = { image: process.env.GRAPHYARD_TRIAL_IMAGE, slots: process.env[slotsDirectoryVariable] };
before(async () => {
  hosts = await shardHosts('host-shim-self-update', ['box'], { [image]: `sha256:${'3780'.repeat(16)}` });
  file = join(hosts.root, 'hosts.json');
  await writeFile(file, JSON.stringify([{ target, addedAt: 'x' }]));
  repository = await shardRepository('host-shim-self-update-repo', files, Object.fromEntries(files.map(name => [name, 'test("adds", () => {})\n'])));
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  process.env[slotsDirectoryVariable] = join(hosts.root, 'slots');
});
after(() => { for (const [name, value] of [['GRAPHYARD_TRIAL_IMAGE', previous.image], [slotsDirectoryVariable, previous.slots]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

// GY-4112: one heat sample per probe, not five 0.5 s apart; each probe cost 2.6 s of sleep on a machine with sensors.
const probeOnce = { GRAPHYARD_PROBE_SAMPLE_SECONDS: '0' };
const run: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
  return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, ...probeOnce, PATH: `${hosts.bin}:${process.env.PATH}` }, ...(command === 'node' ? { wrapper: undefined } : {}) });
};
// GY-3952: an older release's helper lacks a verb this release speaks (receive-image:4); only that makes the loop update it.
const lacking = hostShimVerbs.filter(verb => verb !== 'receive-image:4').join(' ');
const shims = () => join(hosts.home('box'), '.graphyard', 'shims');
/** The host as prepared by an older release: another digest, and a run-shard revision this release's trials cannot use. */
const installOlder = async (verbs = hostShimVerbs.join(' ').replace(/run-shard:\d+/, 'run-shard:1'), edit = (script: string) => script) => {
  await rm(shims(), { recursive: true, force: true });
  await writeFile(hosts.shim, fixtureShim(edit(hostShimScript.replace(hostShimDigest, 'a'.repeat(64)).replace(hostShimVerbs.join(' '), verbs)), hosts.root));
};
const loop = async () => (await readHostReadings([], { file, run, local: 'here', update: true })).find(reading => reading.host === target)!;
const shim = (command: string, input: string) => spawnSync(hosts.shim, [], { input, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: hosts.home('box'), SSH_ORIGINAL_COMMAND: command } });

test(`${proof} — the loop updates a host on an older shim, its line clears and shards go there`, { timeout: 300_000 }, async () => {
  for (const verbs of [lacking, undefined]) {
    await installOlder(verbs);
    const updated = await loop();
    assert.equal(updated.away, false, updated.reason);
    assert.equal(updated.older, undefined, 'the probe after the update reads current');
    assert.deepEqual(outdatedShimAttention([updated]), []);
  }
  const result = await runTrial({ root: repository.root, base: await temporaryDirectory('host-shim-self-update-base'), mergeSha: repository.sha, changedFiles: files, timeoutMs: 240_000, cores: 2, run, retries: 0,
    remote: { hosts: [target], read: async named => (await readShardHosts(named, run, 2)).map(reading => ({ ...reading, cores: reading.away ? 0 : 2, busy: 0, steal: 0, celsius: null })) } });
  assert.equal(result.build, 'pass', result.logTail);
  assert.ok((await dockerCreates(hosts.state('box'))).length > 0, 'the updated host ran shards');

  // The next release updates the updated copy in its place.
  const [copy] = await readdir(shims());
  await writeFile(join(shims(), copy!), hostShimScript.replace(hostShimDigest, 'c'.repeat(64)).replace(' receive-image:4', ''));
  assert.equal((await loop()).older, undefined);
  assert.deepEqual(await readdir(shims()), [copy], 'one copy');
});

test(`${proof} — a shim with a wrong digest is refused and the host keeps its own`, async () => {
  await installOlder();
  const refused = shim(`update-shim ${'f'.repeat(64)}`, hostShimScript);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refuses the update: its content does not match/);
  assert.equal(existsSync(shims()), false, 'nothing was written');
  assert.match(shim('probe', '').stdout, /^shim a{64}$/m);
  assert.equal(shim('update-shim ../x', hostShimScript).status, 1);
  const digest = createHash('sha256').update(hostShimScript).digest('hex');
  assert.match(shim(`update-shim ${digest}`, hostShimScript).stderr, /refuses the update: no key this host was prepared with signed it/, 'GY-3879: an unsigned update is refused');
  const signed = execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', helperSigningKeyFile(), '-n', 'mainworks-helper'], { input: hostShimScript, encoding: 'utf8' });
  const taken = shim(`update-shim ${digest}`, signed + hostShimScript);
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(shim('probe', '').stdout, new RegExp(`^shim ${hostShimDigest}$`, 'm'));
});

test(`${proof} — a host whose update fails stays ready, for trials too, with the reason in its attention line (GY-3896)`, async () => {
  await installOlder(lacking, script => script.replace('os.replace(file.name, own)', "sys.exit('No space left on device')"));
  const failed = await loop();
  assert.equal(failed.away, false);
  const [line] = outdatedShimAttention([failed]);
  assert.match(line!.text, /did not take this release's helper: No space left on device/);
  const trial = async () => (await readShardHosts([target], run, 2)).find(reading => reading.name === target)!;
  assert.equal((await trial()).away, false);
  await installOlder(lacking);
  assert.equal((await loop()).updateError, undefined, 'it clears with the next update that works');
});

test(`${proof} — a host prepared by the printed script takes the update as gy-compute, and preparing it again runs the installed helper`, async () => {
  const prepared = await fakeHosts('host-shim-self-update-prepared', [{ name: 'box' }]);
  const older = { script: hostShimScript.replace(hostShimDigest, 'a'.repeat(64)).replace(' receive-image:4', ''), digest: 'a'.repeat(64) };
  await prepared.prepare('box', { shim: older });
  const hostRun: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, ...probeOnce, PATH: `${prepared.bin}:${process.env.PATH}` } });
  const read = async (update: boolean) => (await readHostReadings([], { file, run: hostRun, local: 'here', update })).find(reading => reading.host === target)!;
  assert.equal((await read(false)).older, true);
  assert.equal((await read(true)).older, undefined);
  assert.equal((await read(false)).older, undefined, 'the next probe reads current');
  assert.equal(await readFile(join(prepared.host('box'), 'usr-local-bin', `graphyard-host-shim-${older.digest}`), 'utf8'), older.script.replaceAll('/etc/ssh/', `${prepared.host('box')}/etc/ssh/`), 'the root-owned file is untouched');
  await prepared.prepare('box', { shim: older });
  assert.equal((await read(false)).older, true);
});
