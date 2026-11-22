import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runShardsOnHosts, type HostReading, type PlacedHost } from '../src/merge-writer/remote-shards.js';

// GY-3607: tests/verification-uses-remote-hosts.test.ts failed on the batch gate (d7fc94e42047) and passed its
// re-run. The fixture mocks each fake host's reading but left `away` to the live probe over the fake ssh: one
// probe hiccup under the gate's load read a host away, its shards fell back onto this machine (GY-3588 keeps it
// always usable, holding the strict cap's one slot), and every placement assertion flipped. The fixture's hosts
// are ready by construction, so their reading says so completely: the override pins away false.

test('unit:verification-uses-remote-hosts-pinned — the fixture owns its hosts\' readings: away is pinned false, never read from the probe', () => {
  const spec = readFileSync(join(process.cwd(), 'tests/verification-uses-remote-hosts.test.ts'), 'utf8');
  const override = spec.split('\n').find(line => line.includes('read: async named'));
  assert.ok(override, 'the fixture overrides the readings its trial places shards by');
  assert.match(override, /away: false/, 'a probe failure never reads a fixture host away: the pinned reading is ready');
});

test('unit:verification-uses-remote-hosts-pinned — a host read away takes its shards onto this machine, which is why the fixture pins readiness', async () => {
  const reading = (name: string, away = false): HostReading => ({ name, cores: 8, busy: 0, steal: 0, celsius: null, limit: 85, away });
  const local: PlacedHost<string> = { name: 'here', room: 2, reading: { ...reading('here'), cores: 2, busy: 2 } };
  const place = async (hostBAway: boolean) => {
    const hosts: PlacedHost<string>[] = [local,
      { name: 'host-a', remote: 'host-a', room: 8, reading: reading('host-a') },
      { name: 'host-b', remote: 'host-b', room: 8, reading: reading('host-b', hostBAway) }];
    return (await runShardsOnHosts({ count: 10, hosts, breadth: 1, run: async () => {} })).ran;
  };
  const ready = await place(false);
  assert.deepEqual(new Set(ready), new Set(['host-a', 'host-b']), 'with both hosts ready every shard runs on them');
  const away = await place(true);
  assert.ok(away.includes('here'), `a host read away pushes its shards onto this machine: ${away.join(', ')}`);
});
