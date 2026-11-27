import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeHosts } from './helpers/fake-hosts.js';
import { main } from '../src/cli/index.js';

// GY-4009: one machine added under a second name (an ssh-config alias) or another port is the host
// already recorded, matched by its SSH host key: hosts.json keeps one entry and host add names it.
// A genuinely new machine is still added.

let hosts: Awaited<ReturnType<typeof fakeHosts>>, config: string;
const saved = { PATH: process.env.PATH, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME, HOME: process.env.HOME };

before(async () => {
  hosts = await fakeHosts('host-add-same-machine', [{ name: 'box', tailscale: true }, { name: 'other' }]);
  config = join(hosts.root, 'config');
  const home = join(hosts.root, 'operator-home');
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'config'), 'Host boxy\n  HostName box\n  User gy-compute\n  Port 2222\n');
  process.env.PATH = `${hosts.bin}:${process.env.PATH}`;
  process.env.GRAPHYARD_CONFIG_HOME = config;
  process.env.HOME = home;
});
after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });

const recorded = async () => JSON.parse(await readFile(join(config, 'machine', 'hosts.json'), 'utf8').catch(() => '[]')).map((host: { target: string }) => host.target);
const output = async (argv: string[]) => {
  const lines: string[] = [], log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try { await main(argv); } finally { console.log = log; }
  return lines.join('\n');
};

test('integration:host-add-same-machine-other-name — host add under a second name or port for a recorded machine keeps one entry and names it; a new machine is added', async () => {
  assert.match(await output(['host', 'add', 'gy-compute@box:2222']), /^Added gy-compute@box:2222: /);
  assert.equal(await output(['host', 'add', 'boxy']), 'boxy is the machine already added as gy-compute@box:2222: kept that one entry.');
  assert.equal(await output(['host', 'add', 'gy-compute@box']), 'gy-compute@box is the machine already added as gy-compute@box:2222: kept that one entry.', 'the same machine on port 22 is the same host');
  assert.deepEqual(await recorded(), ['gy-compute@box:2222'], 'one machine is one entry, not two');
  assert.match(await output(['host', 'add', 'gy-compute@other']), /^Added gy-compute@other: /);
  assert.deepEqual(await recorded(), ['gy-compute@box:2222', 'gy-compute@other']);
});
