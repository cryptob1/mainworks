import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { slotsDirectoryVariable, writeMachines } from '../src/master/verification-slots.js';
import { parseHostProbe } from '../src/hosts.js';
import { heatFallbacksInLastHour, readHeatFallbacks, recordHeatFallback } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3948 AC-2: status shows, per host, the smoothed heat used for placement, and counts how many
// checks or shards were placed elsewhere for heat in the last hour.

const proof = 'unit:status-shows-heat-fallback-count';

test(`${proof} — status shows smoothed per-host heat and counts checks and shards placed elsewhere for heat in the last hour`, async () => {
  const root = await temporaryDirectory('gy-3948-status-root');
  const heavy = join(root, 'heavy-jobs');
  // GY-4021: recordHeatFallback prunes by the real clock (24h retention), so the fixture's times
  // must be relative to it; a fixed date expired every record a day after GY-3948 landed.
  const now = Date.now();

  // Probe output with a 96C instantaneous spike but a 78C smoothed median.
  const probed = parseHostProbe([
    'cores 24',
    'load 3.00',
    'cpu  100 0 50 900 0 0 0 0 0 0',
    'temp coretemp 96000',
    'temp-median 78',
    'runs 0',
  ].join('\n'))!;
  assert.equal(probed.celsius, 78);

  // Record fallbacks: 1 check 10m ago, 3 shards 30m ago, and 2 old fallbacks 2h ago.
  await recordHeatFallback(root, { kind: 'check', count: 1, at: new Date(now - 10 * 60_000).toISOString(), hosts: ['gy-compute@vish-msi'] });
  await recordHeatFallback(root, { kind: 'shard', count: 3, at: new Date(now - 30 * 60_000).toISOString(), hosts: ['gy-compute@vish-msi'] });
  await recordHeatFallback(root, { kind: 'check', count: 2, at: new Date(now - 120 * 60_000).toISOString(), hosts: ['gy-compute@vish-msi'] });

  assert.equal(heatFallbacksInLastHour(readHeatFallbacks(root), now), 4);

  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = heavy;
  try {
    writeMachines(heavy, [
      { name: 'this machine', local: true, away: false, cores: 8, busy: 2, celsius: 60 },
      { name: 'gy-compute@vish-msi:2222', away: false, cores: 24, busy: 3, celsius: probed.celsius },
    ]);
    const master = {
      url: 'http://127.0.0.1:5',
      repository: 'owner/fixture',
      credentialFile: join(root, 'coordinator.token'),
      hostId: 'yard-box',
      baseBranch: 'main',
      workers: [],
      run: { intervalSeconds: 30 },
    } as unknown as MasterConfig;
    const status = await masterStatusReport(
      root,
      master,
      async () => ({ work: [], now: new Date(now).toISOString() }),
      async () => '',
    );
    assert.deepEqual(status.heavyJobs.machines, [
      'this machine: 2 of 8 cores busy, 60°C',
      'vish-msi: 3 of 24 cores busy, 0 shards, 78°C',
    ]);
    assert.equal(status.heavyJobs.heatFallbacksLastHour, 4);
  } finally {
    if (previous === undefined) delete process.env[slotsDirectoryVariable];
    else process.env[slotsDirectoryVariable] = previous;
  }
});
