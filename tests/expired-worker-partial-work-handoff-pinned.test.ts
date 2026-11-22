import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diskFloorBytes } from '../src/merge-writer/trial-load.js';

// GY-3657: the partial-work handoff scenario spread the production effects (daemonEffects) and
// replaced Herdr, the dispatch and the CPU reading (GY-3373) but not the disk one, so its cycle's
// diskHeadroomStep read the trial host's real volumes. Under the 30 GB floor the dispatch step held
// the redispatch and no epoch-2 claim landed: the file was red on main (29f1d87d, 308809ea) on any
// host whose disk was low. GY-3644 switched the reading off (diskVolumes: undefined, which
// diskHeadroomStep skips); this pins that the scenario never reads the host's disk again.

test('unit:expired-worker-partial-work-handoff-pinned — the partial-work handoff scenario reads no host disk, so a nearly-full trial host cannot hold its in-cycle redispatch', async () => {
  const text = await readFile(new URL('./expired-worker-partial-work-handoff.test.ts', import.meta.url), 'utf8');
  const switchedOff = /diskVolumes:\s*undefined\b/.test(text);
  const readings = [...text.matchAll(/diskVolumes:\s*async\s*\(\)\s*=>\s*\[\s*\{\s*path:\s*install,\s*freeBytes:\s*([\d.e_]+)\s*\}\s*\]/g)].map(match => Number(match[1]!.replace(/_/g, '')));
  assert.ok(switchedOff || readings.length > 0, 'the scenario\'s effects carry their own diskVolumes answer, not the production one that reads the host');
  const floor = diskFloorBytes({ run: {} });
  for (const freeBytes of readings) assert.ok(freeBytes >= floor, `the scenario's reading is at or above the ${floor / 1e9} GB floor the dispatch step enforces (got ${freeBytes / 1e9} GB)`);
});
