import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { fakeHosts, ownerLogin } from './helpers/fake-hosts.js';
import { main } from '../src/cli/index.js';
import { hostShimDigest } from '../src/host-shim.js';
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
