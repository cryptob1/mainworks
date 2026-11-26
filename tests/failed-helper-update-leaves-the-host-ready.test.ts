import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { hostShimVerbs } from '../src/host-shim.js';
import { readHostReadings, type HostReading } from '../src/hosts.js';
import { heavyJobBudget, writeMachines } from '../src/master/verification-slots.js';
import { outdatedShimAttention, readShardHosts } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3896 AC-1: a host whose probe offers every trial verb is ready whatever its helper's release and
// whatever an update attempt did. A failed update is one attention line naming the host and the reason,
// retried at most once an hour, and never changes readiness or the heavy-job budget.

const proof = 'unit:failed-helper-update-leaves-the-host-ready';
const target = 'gy-compute@msi';
const probeText = (digest: string) => [`shim ${digest}`, `verbs ${hostShimVerbs.join(' ')}`, 'user 1001 gy-compute', 'compose 2.fixture', 'cores 12', 'load 1.0', 'cpu 100 0 100 800 0 0 0 0 0 0', 'runs 0', ''].join('\n');

let config: string, file: string;
const saved = process.env.GRAPHYARD_CONFIG_HOME;
before(async () => {
  config = await temporaryDirectory('failed-helper-update-config');
  process.env.GRAPHYARD_CONFIG_HOME = config;
  file = join(config, 'hosts.json');
  await writeFile(file, JSON.stringify([{ target, addedAt: '2026-11-20T00:00:00.000Z', login: 'vish@msi' }]));
});
after(() => { if (saved === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = saved; });

/** A host on an older helper that speaks every trial verb; its update fails as `failure` says. */
const fakeHost = (failure: 'raises' | 'keeps-old') => {
  const calls = { updates: 0 };
  const run: ChildRun = async (command, args) => {
    if (command === 'sh' && args[1]?.includes('update-shim ')) {
      calls.updates++;
      if (failure === 'raises') throw Object.assign(new Error('exit 1'), { status: 1, stderr: 'this helper has no trusted signer: run mainworks host add USER@HOST once\n' });
      return '';
    }
    return probeText('1'.repeat(64));
  };
  return { run, calls };
};
const hostOf = (readings: HostReading[]) => readings.find(reading => reading.host === target)!;

for (const failure of ['raises', 'keeps-old'] as const) {
  test(`${proof} — an update that ${failure === 'raises' ? 'raises' : 'leaves the older helper running'} keeps the host ready, in the budget and on trials, with one line`, async () => {
    const { run, calls } = fakeHost(failure);
    const first = await readHostReadings([], { file, run, local: 'here', update: true });
    const host = hostOf(first);
    assert.equal(host.away, false, `a failed update never sets a host away: ${host.reason}`);
    assert.equal(host.update, undefined);
    assert.ok(host.updateError, 'the reason is kept');
    assert.equal(calls.updates, 1, 'one attempt per cycle');

    const lines = outdatedShimAttention(first).filter(line => line.subject === `host ${target}`);
    assert.equal(lines.length, 1, 'the failure shows once');
    assert.match(lines[0]!.text, new RegExp(`^${target} keeps taking shards but did not take this release's helper: ${host.updateError!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

    const slots = await temporaryDirectory('failed-helper-update-slots');
    writeMachines(slots, first.map(reading => ({ name: reading.host, local: reading.local, away: reading.away, cores: reading.cores, busy: reading.busy ?? null, celsius: reading.celsius })));
    assert.ok(heavyJobBudget(slots).machines.some(machine => machine.name === target && machine.slots > 0), 'the budget counts the host');
    const shards = await readShardHosts([target], run, 2);
    assert.equal(shards.find(reading => reading.name === target)!.away, false, 'it still receives shards');

    // Within the hour the loop does not try again; the reason carries forward and the line stays one.
    const second = await readHostReadings(first, { file, run, local: 'here', update: true });
    assert.equal(calls.updates, 1, 'no retry within the hour');
    assert.equal(hostOf(second).away, false);
    assert.equal(hostOf(second).updateError, host.updateError);
    assert.equal(outdatedShimAttention(second).length, 1);

    // An hour later it tries once more.
    const anHourAgo = first.map(reading => reading.host === target ? { ...reading, updateFailedAt: new Date(Date.now() - 3_600_000).toISOString() } : reading);
    await readHostReadings(anHourAgo, { file, run, local: 'here', update: true });
    assert.equal(calls.updates, 2, 'retried after an hour');
  });
}
