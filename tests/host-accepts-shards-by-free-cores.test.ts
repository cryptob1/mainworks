import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { heavyJobBudget, hostShardRoom, slotsDirectoryVariable, takeHostSlot, writeMachines, type HeldSlot, type Machine } from '../src/master/verification-slots.js';
import { HostBusyError, runShardsOnHosts, type PlacedHost } from '../src/merge-writer/remote-shards.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { withEnv } from './helpers/env.js';

// GY-3706: one shard per six cores left the hosts idle while this machine carried the trial. A host
// takes shards while its busy cores plus the shards placed there stay under its cores less two;
// whole heavy jobs keep one place per six cores.

const msi = 'gy-compute@vish-msi:2222', omarchy = 'gy-compute@omarchypc:2222';
const machines = (msiBusy = 0, localBusy = 6): Machine[] => [
  { name: 'vishrog', local: true, away: false, cores: 24, busy: localBusy, celsius: 61 },
  { name: msi, away: false, cores: 24, busy: msiBusy, celsius: 58 },
  { name: omarchy, away: false, cores: 32, busy: 0, celsius: 60 },
];
async function takeAll(directory: string, host: string, label: string) {
  const held: HeldSlot[] = [];
  for (let shard = 1; shard <= 40; shard++) { const slot = await takeHostSlot(directory, host, `${label} shard ${shard}`, 'acme/app'); if (!slot) break; held.push(slot); }
  return held;
}
const heavyDirectory = async (name: string) => { const directory = join(await temporaryDirectory(name), 'heavy-jobs'); mkdirSync(directory); return directory; };

test('unit:host-accepts-shards-by-free-cores — an idle 24-core host accepts 22 shards and refuses the 23rd; one with 20 busy cores accepts 2; a limit file leaves hosts unbounded; heavy jobs keep floor(cores / 6)', { timeout: 60_000 }, async () => {
  const directory = await heavyDirectory('shards-by-free-cores');
  writeMachines(directory, machines());
  const idle = await takeAll(directory, msi, 'test merge GY-1');
  assert.equal(idle.length, 22, 'an idle 24-core host accepts 22 shards');
  assert.equal(await takeHostSlot(directory, msi, 'test merge GY-1 shard 23'), null, 'and refuses the 23rd');
  assert.equal(hostShardRoom(directory, msi), 22);
  // Whole heavy jobs keep one place per six cores.
  assert.deepEqual(heavyJobBudget(directory).machines.map(machine => machine.slots), [4, 4, 5]);
  for (const slot of idle) slot.release();

  writeMachines(directory, machines(20));
  assert.equal((await takeAll(directory, msi, 'test merge GY-2')).length, 2, 'a host with 20 busy cores accepts 2');

  const limited = await heavyDirectory('shards-by-free-cores-limit');
  writeMachines(limited, machines(20));
  writeFileSync(join(limited, 'limit'), '3\n');
  assert.equal((await takeAll(limited, msi, 'test merge GY-3')).length, 40, 'a limit file leaves hosts unbounded');
  assert.equal(hostShardRoom(limited, msi), Infinity);
});

test('unit:host-accepts-shards-by-free-cores — with idle hosts of 24 and 32 cores a 60-shard trial places at least 50 shards on them and none is refused while a host has free cores', { timeout: 60_000 }, async () => {
  const directory = await heavyDirectory('shards-by-free-cores-trial');
  writeMachines(directory, machines());
  const reading = (name: string, cores: number) => ({ name, cores, busy: 0, steal: 0, celsius: 60, limit: 85, away: false });
  const hosts: PlacedHost<string>[] = [
    { name: 'vishrog', room: 8, reading: reading('vishrog', 24) },
    ...[[msi, 24], [omarchy, 32]].map(([host, cores]) => ({ name: host as string, remote: host as string, reading: reading(host as string, cores as number), room: Math.min(cores as number, hostShardRoom(directory, host as string)) })),
  ];
  let started = 0, refused = 0, release!: () => void;
  const all = new Promise<void>(done => { release = done; });
  const placement = await runShardsOnHosts({ count: 60, hosts, breadth: 1, run: async (host, index) => {
    const held = host.remote ? await takeHostSlot(directory, host.remote, `test merge GY-4 shard ${index + 1}`, 'acme/app') : null;
    if (host.remote && !held) { refused++; throw new HostBusyError(host.remote); }
    if (++started === 60) release();
    try { await Promise.race([all, new Promise(done => setTimeout(done, 2_000))]); } finally { held?.release(); }
  } });
  assert.equal(refused, 0, 'no shard is refused while a host has free cores');
  const remote = placement.ran.filter(name => name !== 'vishrog').length;
  assert.ok(remote >= 50, `at least 50 of 60 shards run on the hosts: ${remote}`);
});

test('unit:host-accepts-shards-by-free-cores — master status shows each host\'s shards beside its busy cores, and one attention line once this machine is overloaded while a host sits half free for 5 minutes', { timeout: 60_000 }, async () => {
  const root = await temporaryDirectory('shards-by-free-cores-status'), directory = await heavyDirectory('shards-by-free-cores-status-data');
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, '.graphyard'));
  const credentialFile = join(root, 'token');
  writeFileSync(credentialFile, 'fixture-token', { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', cliPath: process.execPath, repository: 'acme/app', baseBranch: 'main', hostId: 'loop-host',
    masterAgentName: 'graphyard-master-app', workers: [], credentialFile, run: {} }) as never;
  writeFileSync(join(root, '.graphyard/master.json'), JSON.stringify(master), { mode: 0o600 });
  const status = (now: Date) => masterStatusReport(root, master, async () => ({ work: [], now: now.toISOString() }), async () => { throw new Error('no git in the fixture'); });
  const imbalance = (attention: { subject: string; text: string }[]) => attention.filter(line => line.subject === 'shard placement');
  await withEnv({ [slotsDirectoryVariable]: directory }, async () => {
    const start = new Date();
    writeMachines(directory, machines(3, 30), start);
    const held = [await takeHostSlot(directory, msi, 'test merge GY-5 shard 1', 'acme/app'), await takeHostSlot(directory, msi, 'test merge GY-5 shard 2', 'acme/app')];
    const shown = await status(start);
    assert.deepEqual(shown.heavyJobs.machines, ['this machine: 30 of 24 cores busy, 61°C', 'vish-msi: 3 of 24 cores busy, 2 shards, 58°C', 'omarchypc: 0 of 32 cores busy, 0 shards, 60°C']);
    assert.deepEqual(imbalance(shown.attention), [], 'no line before 5 minutes');
    const later = new Date(start.getTime() + 6 * 60_000);
    writeMachines(directory, machines(3, 30), later);
    const lines = imbalance((await status(later)).attention);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.text, /This machine is at load 30 on 24 cores while omarchypc has 32 of 32 cores free, for 6 minutes/);
    // Once this machine is back under its cores the line clears.
    writeMachines(directory, machines(3, 10), later);
    assert.deepEqual(imbalance((await status(later)).attention), []);
    for (const slot of held) slot?.release();
  });
});
