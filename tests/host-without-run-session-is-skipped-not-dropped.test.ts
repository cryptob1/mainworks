import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimVerbs } from '../src/host-shim.js';
import { hostAddCommand, readHostReadings, readHosts, sessionHelperProblem } from '../src/hosts.js';
import { builderSessionCounts, remoteSessionHost } from '../src/remote-session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4004 AC-2: the two helper versions probed on 2026-11-27. vish-msi's helper has run-session:1 and
// update-shim:2; omarchypc's has neither (receive-image:1, prepare-run:1, run-shard:2). Both are opened
// to three sessions. A builder of any runtime the image holds goes to vish-msi; omarchypc is skipped for
// sessions with the reason `host list` gives, stays added and stays ready; with vish-msi full or hot the
// builder runs on the coordinator. master status counts each host's builders and the coordinator's.

const proof = 'integration:host-without-run-session-is-skipped-not-dropped';
const msi = 'gy-compute@vish-msi-compute', omarchy = 'gy-compute@omarchypc-compute';
const oldVerbs = 'probe:1 receive-pack:1 receive-image:1 prepare-run:1 run-shard:2 fetch-records:1 clean:1';
const probe = (shim: string, verbs: string, celsius = 50) => ['shim ' + shim, 'verbs ' + verbs, 'user 1001 gy-compute', 'cores 32', 'load 1.00', `temp-median ${celsius}`, 'cpu 100 0 100 800 0 0 0 0 0 0', 'runs 0'].join('\n');

async function fixture(msiCelsius = 50) {
  const dir = await temporaryDirectory('host-without-run-session');
  const file = join(dir, 'hosts.json');
  // omarchypc's sessions count is written as an older release would have left it: `host sessions` itself refuses it now.
  await writeFile(file, JSON.stringify([{ target: omarchy, addedAt: '2026-11-20T00:00:00.000Z', sessions: 3 }, { target: msi, addedAt: '2026-11-20T00:00:00.000Z', sessions: 3 }]));
  const run: ChildRun = async (command, args) => {
    if (command === 'sh') return probe(hostShimDigest, hostShimVerbs.join(' '));
    const target = args.find(arg => arg.startsWith('gy-compute@'));
    if (command === 'ssh' && target === msi) return probe(hostShimDigest, hostShimVerbs.join(' '), msiCelsius);
    if (command === 'ssh' && target === omarchy) return probe('1'.repeat(64), oldVerbs);
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  return { dir, file, run };
}

test(`${proof} — a builder of every runtime goes to the host whose helper runs sessions; the older helper's host is skipped, stays added and stays ready`, async () => {
  const { dir, file, run } = await fixture();
  for (const kind of ['claude', 'codex', 'opencode', 'cursor']) assert.equal(await remoteSessionHost(kind, () => [], run, file), msi, `a ${kind} builder runs on ${msi}`);
  assert.equal(await remoteSessionHost('claude', () => [msi, msi], run, file), msi, 'while it has room it takes more');
  assert.equal(await remoteSessionHost('claude', () => [msi, msi, msi], run, file), null, `with ${msi} full the builder runs on the coordinator, never on ${omarchy}`);
  assert.equal(await sessionHelperProblem(omarchy, run), `${omarchy}'s helper is older than this release and takes no sessions: run ${hostAddCommand(omarchy)} first`);
  assert.deepEqual((await readHosts(file)).map(host => [host.target, host.sessions]), [[omarchy, 3], [msi, 3]], 'no host is removed or closed to sessions for it');
  const readings = await readHostReadings([], { file, knownHosts: join(dir, 'known_hosts'), run, local: 'here' });
  assert.equal(readings.find(reading => reading.host === omarchy)?.away, false, `${omarchy} stays ready for test shards`);
});

test(`${proof} — a host at its heat limit takes no builder: it runs on the coordinator`, async () => {
  const { file, run } = await fixture(90);
  assert.equal(await remoteSessionHost('claude', () => [], run, file), null);
});

test(`${proof} — master status counts the builders each host runs and the coordinator's`, () => {
  assert.deepEqual(builderSessionCounts([msi, null, msi, null, null], [{ target: omarchy, sessions: 3 }, { target: msi, sessions: 3 }, { target: 'gy-compute@shards-only' }]),
    { coordinator: 3, hosts: [{ host: omarchy, running: 0, room: 3 }, { host: msi, running: 2, room: 3 }] });
});
