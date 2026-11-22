import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostDroppedError, runShardsOnHosts, type HostReading, type PlacedHost } from '../src/merge-writer/remote-shards.js';

// GY-3609: heat on the coordinator is what slows and serialises trials, and the tests can run
// elsewhere. A shard goes to a ready compute machine first; the coordinator runs one only when the
// shard is pinned to it or no other machine is usable with room.

const proof = 'unit:shards-prefer-a-ready-remote-host';
const reading = (name: string, cores: number, extra: Partial<HostReading> = {}): HostReading => ({ name, cores, busy: 0, steal: 0, celsius: 60, limit: 92, away: false, ...extra });
/** The coordinator with far more free CPU than the one remote machine, which has `room` places. */
const machines = (room: number, remote: Partial<HostReading> = {}): PlacedHost<string>[] => [
  { name: 'coordinator', room: 8, reading: reading('coordinator', 64) },
  { name: 'box', room, reading: reading('box', 8, remote), remote: 'box' },
];
/** Where each shard started, all held running until every placement was made. */
async function starts(input: { count: number; hosts: PlacedHost<string>[]; pinned?: boolean[] }) {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const placed = runShardsOnHosts({ ...input, breadth: 1, run: async (host, index) => { started[index] = host.name; await gate; } });
  await new Promise(resolve => setImmediate(resolve));
  release();
  await placed;
  return started;
}

test(`${proof} — with a remote machine usable and with room, every unpinned shard runs on it and none on the coordinator, whatever the coordinator's free CPU`, async () => {
  assert.deepEqual(await starts({ count: 4, hosts: machines(4) }), ['box', 'box', 'box', 'box']);
});

test(`${proof} — a shard pinned local-only still runs on the coordinator`, async () => {
  assert.deepEqual(await starts({ count: 3, hosts: machines(4), pinned: [false, true, false] }), ['box', 'coordinator', 'box']);
});

test(`${proof} — when the remote machine is full, the shards beyond its room run on the coordinator`, async () => {
  assert.deepEqual(await starts({ count: 4, hosts: machines(2) }), ['box', 'box', 'coordinator', 'coordinator']);
});

test(`${proof} — a hot remote machine takes no shard, and one that drops hands its shards back to the coordinator`, async () => {
  assert.deepEqual(await starts({ count: 2, hosts: machines(4, { celsius: 95 }) }), ['coordinator', 'coordinator']);
  const result = await runShardsOnHosts({ count: 3, hosts: machines(4), breadth: 1, run: async host => { if (host.remote) throw new HostDroppedError('box', 'connection closed'); } });
  assert.deepEqual(result, { ran: ['coordinator', 'coordinator', 'coordinator'], queuedWhileIdle: 0, dropped: ['box'] });
});
