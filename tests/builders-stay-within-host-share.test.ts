import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimVerbs } from '../src/host-shim.js';
import { remoteSessionHost } from '../src/remote-session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4004 AC-3: a host shared with another install takes this install's builders only up to the session
// count this install set for it (host sessions N), and none while its load leaves its trials no shard
// room (cores less two, as shards are placed). Placement only reads: the hosts file, and so the other
// install's keys, helper and settings on the host, are untouched.

const proof = 'integration:builders-stay-within-host-share';
const shared = 'gy-compute@omarchypc-compute';
const probe = (cores: number, load: number) => ['shim ' + hostShimDigest, 'verbs ' + hostShimVerbs.join(' '), 'user 1001 gy-compute', `cores ${cores}`, `load ${load.toFixed(2)}`, 'temp-median 50', 'cpu 100 0 100 800 0 0 0 0 0 0', 'runs 0'].join('\n');

async function fixture(cores: number, load: number) {
  const dir = await temporaryDirectory('builders-host-share');
  const file = join(dir, 'hosts.json');
  await writeFile(file, JSON.stringify([{ target: shared, addedAt: '2026-11-20T00:00:00.000Z', sessions: 3 }]));
  const calls: string[] = [];
  const run: ChildRun = async (command, args) => { calls.push(String(args.at(-1))); if (command === 'ssh') return probe(cores, load); throw new Error(`unexpected ${command}`); };
  return { file, run, calls };
}

test(`${proof} — builders on a shared host never exceed the session count this install set for it`, async () => {
  const { file, run, calls } = await fixture(32, 4);
  const before = await readFile(file, 'utf8');
  for (const live of [[], [shared], [shared, shared]]) assert.equal(await remoteSessionHost('claude', () => live, run, file), shared, `${live.length} of 3 running: one more goes there`);
  assert.equal(await remoteSessionHost('claude', () => [shared, shared, shared], run, file), null, '3 of 3 running: the next runs on the coordinator');
  assert.equal(await readFile(file, 'utf8'), before, 'placement changes no host setting');
  assert.deepEqual([...new Set(calls)], ['probe'], 'placement only probes the host: no key, helper or setting there is touched');
});

test(`${proof} — a host whose load leaves its trials no shard room takes no new builder`, async () => {
  assert.equal(await remoteSessionHost('claude', () => [], (await fixture(8, 6)).run, (await fixture(8, 6)).file), null, '8 cores, 6 busy: no room past cores less two');
  const roomy = await fixture(8, 5.5);
  assert.equal(await remoteSessionHost('claude', () => [], roomy.run, roomy.file), shared, '8 cores, 5.5 busy: room left');
});
