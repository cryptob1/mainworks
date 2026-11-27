import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimVerbs } from '../src/host-shim.js';
import { readHostReadings } from '../src/hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3952 AC-2: the loop updates a host's helper only when the helper lacks a verb this release speaks,
// never because its digest differs. Two releases share one helper (one coordinator address): the other
// release's helper speaks every verb this one needs, so this release's probes leave it alone; a helper
// lacking a verb takes this release's once, and the next probe leaves that one alone too.

const proof = 'unit:helper-updated-only-for-a-missing-verb';
const target = 'gy-compute@msi';
const probeText = (digest: string, verbs: readonly string[]) => [`shim ${digest}`, `verbs ${verbs.join(' ')}`, 'user 1001 gy-compute', 'compose 2.fixture', 'cores 12', 'load 1.0', 'cpu 100 0 100 800 0 0 0 0 0 0', 'runs 0', ''].join('\n');

let file: string;
const saved = process.env.GRAPHYARD_CONFIG_HOME;
before(async () => {
  const config = await temporaryDirectory('helper-missing-verb-config');
  process.env.GRAPHYARD_CONFIG_HOME = config;
  file = join(config, 'hosts.json');
  await writeFile(file, JSON.stringify([{ target, addedAt: '2026-11-26T00:00:00.000Z', login: 'vish@msi' }]));
});
after(() => { if (saved === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = saved; });

/** One host whose installed helper is `helper`; an update installs this release's. */
const host = (helper: { digest: string; verbs: readonly string[] }) => {
  const updates: string[] = [];
  const run: ChildRun = async (command, args) => {
    if (command === 'sh' && args[1]?.includes('update-shim ')) { updates.push(helper.digest); helper = { digest: hostShimDigest, verbs: hostShimVerbs }; return ''; }
    return probeText(helper.digest, helper.verbs);
  };
  return { run, updates };
};

test(`${proof} — two releases probing in turn leave each other's helper alone; a helper lacking a verb is updated once`, async () => {
  // The other release's helper: another digest, every verb this release speaks and one more.
  const other = host({ digest: 'b'.repeat(64), verbs: [...hostShimVerbs, 'future-verb:1'] });
  let readings = await readHostReadings([], { file, run: other.run, local: 'here', update: true });
  readings = await readHostReadings(readings, { file, run: other.run, local: 'here', update: true });
  assert.deepEqual(other.updates, [], 'a helper on another digest that speaks every verb is never replaced');
  assert.equal(readings.find(reading => reading.host === target)!.away, false);

  // A helper from before receive-image:4 lacks a verb this release needs: it takes this release's helper once.
  const older = host({ digest: 'a'.repeat(64), verbs: hostShimVerbs.filter(verb => verb !== 'receive-image:4') });
  const first = await readHostReadings([], { file, run: older.run, local: 'here', update: true });
  assert.deepEqual(older.updates, ['a'.repeat(64)], 'the helper lacking receive-image:4 is updated');
  assert.equal(first.find(reading => reading.host === target)!.updateError, undefined);
  await readHostReadings(first, { file, run: older.run, local: 'here', update: true });
  assert.equal(older.updates.length, 1, 'once it speaks every verb the next probe leaves it alone');
});
