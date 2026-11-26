import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { fakeHosts, ownerLogin } from './helpers/fake-hosts.js';
import { main } from '../src/cli/index.js';
import { hostShimDigest, hostShimScript } from '../src/host-shim.js';
import { probeHost, shareHost } from '../src/hosts.js';
import { outdatedShimAttention } from '../src/merge-writer/remote-shards.js';
import infra from '../src/guide/infra.js';

// GY-3834 AC-1: `host add OWNER@HOST` in a terminal prepares the machine over its own SSH session
// (sudo there, prompts reaching the owner's terminal), records gy-compute@HOST and prints one line with
// the probe's result. Without a terminal it changes nothing and prints that exact command. Again on a
// prepared machine it is a no-op that says so; `host prepare` still prints the script; attention lines
// name the one command and never a script to copy.

const proof = 'integration:host-add-prepares-and-registers-in-one-command';
let hosts: Awaited<ReturnType<typeof fakeHosts>>, config: string;
const saved = { PATH: process.env.PATH, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME, HOME: process.env.HOME };
const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

before(async () => {
  hosts = await fakeHosts('host-add-one-command', [{ name: 'fresh', owner: true }]);
  config = join(hosts.root, 'config');
  const home = join(hosts.root, 'operator');
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_ed25519.pub'), `${hosts.publicKey}\n`);
  Object.assign(process.env, { PATH: `${hosts.bin}:${saved.PATH}`, GRAPHYARD_CONFIG_HOME: config, HOME: home });
});
after(() => {
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  Object.assign(process.stdin, { isTTY: tty.stdin }); Object.assign(process.stdout, { isTTY: tty.stdout });
});

const terminal = (on: boolean) => { Object.assign(process.stdin, { isTTY: on }); Object.assign(process.stdout, { isTTY: on }); };
const recorded = async () => JSON.parse(await readFile(join(config, 'machine', 'hosts.json'), 'utf8').catch(() => '[]')).map((host: { target: string }) => host.target);
const sudoCalls = async () => (await readFile(join(hosts.host('fresh'), 'log'), 'utf8').catch(() => '')).split('\n').filter(line => line.startsWith('sudo sh -c')).length;
/** What the command printed: console lines, and the prepare script's relayed output. */
const output = async (argv: string[]) => {
  const lines: string[] = [], relayed: string[] = [], log = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { relayed.push(String(chunk)); return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest); }) as typeof process.stdout.write;
  try { await main(argv); } finally { console.log = log; process.stdout.write = write; }
  return { lines, relayed: relayed.join('') };
};

test(`${proof} — without a terminal nothing changes and the exact command is printed; in a terminal one command prepares, records and probes; again it is a no-op`, { timeout: 120_000 }, async () => {
  const target = `${ownerLogin}@fresh`;
  terminal(false);
  await assert.rejects(main(['host', 'add', target]), (error: Error) => { assert.equal(error.message, `Run this in a terminal: mainworks host add ${target}`); return true; });
  assert.deepEqual(await recorded(), [], 'nothing recorded');
  assert.equal(existsSync(hosts.home('fresh')), false, 'nothing prepared on the host');
  assert.equal(await sudoCalls(), 0);

  terminal(true);
  const added = await output(['host', 'add', target]);
  assert.equal(await sudoCalls(), 1, 'the prepare script ran once, with sudo, over the SSH session');
  assert.match(added.relayed, /Docker for gy-compute: running and starts at boot/, "the script's output reaches the owner's terminal");
  assert.equal(added.lines.length, 1, `one line: ${added.lines.join(' | ')}`);
  assert.match(added.lines[0]!, /^Added gy-compute@fresh: \d+ cores, rootless Docker answers through the shim\./);
  assert.deepEqual(await recorded(), ['gy-compute@fresh']);
  const keys = await readFile(join(hosts.home('fresh'), '.ssh', 'authorized_keys'), 'utf8');
  assert.ok(keys.includes(`restrict,command="graphyard-host-shim-${hostShimDigest}" ${hosts.publicKey}`), "this machine's key reaches only the helper");

  const again = await output(['host', 'add', target]);
  assert.deepEqual(again.lines, ['gy-compute@fresh is already prepared and added: nothing to do.']);
  assert.equal(await sudoCalls(), 1, 'no second sudo');
  assert.deepEqual(await recorded(), ['gy-compute@fresh']);
});

test(`${proof} — host prepare stays for machines with no SSH login, and attention lines name the one command`, async () => {
  assert.match((await output(['host', 'prepare'])).relayed, /#!\/bin\/sh\n# Run once on the host with: sudo sh prepare\.sh/);
  const command = `mainworks host add ${userInfo().username}@box in a terminal`;
  for (const probe of [{ host: 'gy-compute@box', away: true, update: true }, { host: 'gy-compute@box', away: false, older: true }]) {
    const [line] = outdatedShimAttention([probe]);
    assert.ok(`${line!.text} ${line!.next}`.includes(command), `${line!.text} / ${line!.next}`);
    assert.doesNotMatch(`${line!.text} ${line!.next}`, /script|host prepare/);
  }
});

test(`${proof} — guide infra says how to add a machine in at most three sentences`, () => {
  const cell = /^\| Compute machines \| (.*?) Merge trials/m.exec(infra)?.[1] ?? '';
  const sentences = cell.split(/(?<=\.) /);
  assert.ok(sentences.length <= 3, cell);
  assert.match(sentences[0]!, /mainworks host add YOU@HOST` in a terminal/);
  assert.match(sentences[1]!, /host share HOST KEY/);
  assert.match(sentences[2]!, /^Helper updates then need nobody\.$/);
});

test(`${proof} — AC-4: prepare keeps another install's helper; host add updates an older update-shim:2 helper to this release's digest`, { timeout: 120_000 }, async () => {
  // (a) Prepare removes only this install's superseded helper and never another install's helper (direct or shared --home).
  const keyOther = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHTV6f52ARa/vlYRkS8yKc4Chbk2xf06bI6Tny1m2lZq other-install';
  const keyShared = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAB12cd34EF56gh78IJ90kl12MN34op56QR78st90UV1 shared-install';
  const digestOther = 'a'.repeat(64);
  const digestOld = 'b'.repeat(64);
  const pair = await fakeHosts('host-add-ac4', [{ name: 'shared' }, { name: 'outdated', owner: true }]);
  const oldPath = process.env.PATH, oldConfig = process.env.GRAPHYARD_CONFIG_HOME;
  const ac4Config = join(pair.root, 'config');
  Object.assign(process.env, { PATH: `${pair.bin}:${saved.PATH}`, GRAPHYARD_CONFIG_HOME: ac4Config });
  try {
    await pair.prepare('shared', { publicKey: keyOther, shim: { script: hostShimScript.replace(hostShimDigest, digestOther), digest: digestOther } });
    await shareHost('gy-compute@shared', keyShared);
    // This install re-prepares at another digest: both other-install's direct helper and the helper named by shared-install's --home line stay.
    await pair.prepare('shared', { shim: { script: hostShimScript.replace(hostShimDigest, digestOld), digest: digestOld } });
    assert.ok(existsSync(join(pair.host('shared'), 'usr-local-bin', `graphyard-host-shim-${digestOther}`)), "another install's direct helper is kept");
    assert.ok(existsSync(join(pair.host('shared'), 'usr-local-bin', `graphyard-host-shim-${hostShimDigest}`)), "another install's shared --home helper is kept");
    assert.ok(existsSync(join(pair.host('shared'), 'usr-local-bin', `graphyard-host-shim-${digestOld}`)), "this install's new helper is present");

    // Now this install prepares back to hostShimDigest: its own superseded digestOld helper is removed, while digestOther stays.
    await pair.prepare('shared');
    assert.equal(existsSync(join(pair.host('shared'), 'usr-local-bin', `graphyard-host-shim-${digestOld}`)), false, "this install's superseded helper is removed");
    assert.ok(existsSync(join(pair.host('shared'), 'usr-local-bin', `graphyard-host-shim-${digestOther}`)), "another install's helper is still kept");

    // (b) A host whose probed shim has an older digest that lists update-shim:2 is NOT counted as already prepared:
    // host add updates it through update-shim (without sudo) until its probed digest is hostShimDigest.
    await pair.prepare('outdated', { shim: { script: hostShimScript.replace(hostShimDigest, digestOld), digest: digestOld } });
    const beforeProbe = await probeHost('gy-compute@outdated');
    assert.equal(beforeProbe.ok, true);
    assert.equal(beforeProbe.ok && beforeProbe.shim, digestOld, 'starts on an older digest that still speaks update-shim:2');
    assert.ok(beforeProbe.ok && beforeProbe.verbs?.includes('update-shim:2'));

    const sudoBefore = (await readFile(join(pair.host('outdated'), 'log'), 'utf8').catch(() => '')).split('\n').filter(line => line.startsWith('sudo sh -c')).length;
    terminal(false);
    const updated = await output(['host', 'add', `${ownerLogin}@outdated`]);
    assert.equal(updated.lines.length, 1, `one line: ${updated.lines.join(' | ')}`);
    assert.match(updated.lines[0]!, /^Added gy-compute@outdated: \d+ cores, rootless Docker answers through the shim\./);
    const afterProbe = await probeHost('gy-compute@outdated');
    assert.equal(afterProbe.ok, true);
    assert.equal(afterProbe.ok && afterProbe.shim, hostShimDigest, 'host add updated the older helper to this release digest via update-shim');
    const sudoAfter = (await readFile(join(pair.host('outdated'), 'log'), 'utf8').catch(() => '')).split('\n').filter(line => line.startsWith('sudo sh -c')).length;
    assert.equal(sudoAfter, sudoBefore, 'update-shim needed no sudo');

    // Running host add again now that its digest matches hostShimDigest is a no-op.
    const noop = await output(['host', 'add', `${ownerLogin}@outdated`]);
    assert.deepEqual(noop.lines, ['gy-compute@outdated is already prepared and added: nothing to do.']);

    // Even when already recorded, an older update-shim:2 helper is updated to hostShimDigest rather than treated as a no-op.
    await pair.prepare('outdated', { shim: { script: hostShimScript.replace(hostShimDigest, digestOld), digest: digestOld } });
    const reupdated = await output(['host', 'add', `${ownerLogin}@outdated`]);
    assert.deepEqual(reupdated.lines, ["Updated gy-compute@outdated's helper to this release."]);
    const finalProbe = await probeHost('gy-compute@outdated');
    assert.equal(finalProbe.ok && finalProbe.shim, hostShimDigest);
  } finally {
    Object.assign(process.env, { PATH: oldPath, GRAPHYARD_CONFIG_HOME: oldConfig });
  }
});
