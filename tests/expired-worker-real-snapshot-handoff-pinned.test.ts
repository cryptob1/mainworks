import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diskFloorBytes } from '../src/merge-writer/trial-load.js';

// GY-3650: the handoff scenario spread the production effects (daemonEffects) and replaced the
// world beyond the control plane — Herdr, the dispatch, the CPU reading (GY-3373) — but not the
// disk one, so its cycle's diskHeadroomStep read the host's real volumes. This install's root
// volume, where the fixture's temporary install lands, fell under the 30 GB floor, the dispatch
// step held the redispatch ("implementation launches waiting: disk below its floor"), and no
// epoch-2 claim ever landed: the file was red on main on every host whose disk was full, exactly
// the host-telemetry dependence GY-3373 removed for the CPU. The scenario now answers the disk
// reading itself, above the floor, like every other cycle test that spreads the production
// effects. GY-3644 landed the same cause on main by switching the reading off (diskVolumes:
// undefined, which diskHeadroomStep skips); either way the scenario reads no host disk.

test('unit:expired-worker-real-snapshot-handoff-pinned — the handoff scenario answers the loop\'s disk reading itself, above the floor, so a nearly-full host volume cannot hold the in-cycle redispatch', async () => {
  const text = await readFile(new URL('./expired-worker-real-snapshot-handoff.test.ts', import.meta.url), 'utf8');
  const switchedOff = /diskVolumes:\s*undefined\b/.test(text);
  const readings = [...text.matchAll(/diskVolumes:\s*async\s*\(\)\s*=>\s*\[\s*\{\s*path:\s*install,\s*freeBytes:\s*([\d.e_]+)\s*\}\s*\]\s*/g)].map(match => Number(match[1]!.replace(/_/g, '')));
  assert.ok(switchedOff || readings.length > 0, 'the scenario\'s effects carry their own diskVolumes reading, not the production one that reads the host');
  const floor = diskFloorBytes({ run: {} });
  for (const freeBytes of readings) assert.ok(freeBytes >= floor, `the scenario\'s reading is at or above the ${floor / 1e9} GB floor the dispatch step enforces (got ${freeBytes / 1e9} GB)`);
});
