import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zeroRemoteShareAttention, type RemoteShardRun } from '../src/merge-writer/remote-shards.js';

// GY-3928 AC-2: Status shows one attention line when two consecutive merge trials with more than
// ten shards placed none on any ready host, naming the reason the placement gave.

const proof = 'unit:zero-remote-share-raises-attention';

const trialRun = (overrides: Partial<RemoteShardRun> = {}): RemoteShardRun => ({
  at: '2026-11-26T16:30:00.000Z',
  wallMs: 120_000,
  shards: 55,
  remote: 0,
  queuedWhileIdle: 0,
  host: 'vishrog',
  celsius: 65,
  hosts: [
    { name: 'vishrog', away: false, celsius: 65, freeCores: 12 },
    { name: 'gy-compute@vish-msi-compute', away: true, reason: 'graphyard-host-shim refuses: run-shard trial-abc 1', celsius: 70, freeCores: 20 },
    { name: 'gy-compute@omarchypc-compute', away: true, reason: 'graphyard-host-shim refuses: run-shard trial-def 2', celsius: 54, freeCores: 32 },
  ],
  ...overrides,
});

const readyProbes = [
  { host: 'vishrog', local: true, away: false },
  { host: 'gy-compute@vish-msi-compute', away: false },
  { host: 'gy-compute@omarchypc-compute', away: false },
];

test(`${proof} — raises one attention line naming the placement reason after two consecutive >10-shard merge trials place 0 shards on ready hosts, and stays quiet otherwise`, () => {
  // 1. One large trial with 0 remote shards is not enough.
  assert.deepEqual(zeroRemoteShareAttention([trialRun()], readyProbes), []);

  // 2. Two trials with <= 10 shards do not trigger.
  assert.deepEqual(
    zeroRemoteShareAttention([trialRun({ shards: 10 }), trialRun({ shards: 8 })], readyProbes),
    [],
  );

  // 3. Two large worker verifications (label set) do not trigger.
  assert.deepEqual(
    zeroRemoteShareAttention([trialRun({ label: 'worker verify' }), trialRun({ label: 'worker verify' })], readyProbes),
    [],
  );

  // 4. Two large merge trials with 0 remote shards when NO remote host is ready do not trigger.
  assert.deepEqual(
    zeroRemoteShareAttention([trialRun(), trialRun()], [
      { host: 'vishrog', local: true, away: false },
      { host: 'gy-compute@vish-msi-compute', away: true },
    ]),
    [],
  );

  // 5. Two consecutive >10-shard merge trials with 0 remote shards (even with a 1-shard trial in between) raise exactly one attention line naming the placement reason.
  const attention = zeroRemoteShareAttention([
    trialRun({ shards: 58, remote: 0 }),
    trialRun({ shards: 1, remote: 0 }),
    trialRun({ shards: 99, remote: 0 }),
  ], readyProbes);
  assert.equal(attention.length, 1, `expected exactly one attention line: ${JSON.stringify(attention)}`);
  assert.match(attention[0]!.text, /graphyard-host-shim refuses: run-shard/);

  // 6. Clears as soon as the next >10-shard merge trial places at least one shard remotely.
  assert.deepEqual(
    zeroRemoteShareAttention([
      trialRun({ shards: 58, remote: 0 }),
      trialRun({ shards: 99, remote: 0 }),
      trialRun({ shards: 60, remote: 34 }),
    ], readyProbes),
    [],
  );
});
