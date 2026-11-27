import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { acquireVerificationSlot, gateSlot, heavyJobBudget, heavyJobLimit, heldSlots, hostSlot, hostsWithSlots, readMachines, slotsDirectoryVariable, takeHostSlot, workerVerificationLabel, writeMachines, type HeldSlot, type Machine } from '../src/master/verification-slots.js';
import { HostBusyError, runShardsOnHosts, type PlacedHost } from '../src/merge-writer/remote-shards.js';
import { budgetLine, machineLine } from '../src/model/machine-load.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { runningVerificationChildren } from '../src/merge-writer/worker-verification.js';
import { encodeLoopHosts, loopHosts } from '../src/model/loop-presence.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { until } from './helpers/until.js';

// GY-3528: a hard-coded two heavy jobs turned three machines into one queue. The budget is now each
// ready machine's floor(cores / 6): jobs here take this machine's share, a trial's shard placed on a
// host takes that host's. GY-3533: a worker verification's slot is freed within one loop cycle once
// nothing still runs for it.

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const stop = new AbortController();
after(() => stop.abort());

const msi = 'gy-compute@vish-msi:2222', omarchy = 'gy-compute@omarchypc:2222';
const machines = (away: boolean): Machine[] => [
  { name: 'vishrog', local: true, away: false, cores: 24, busy: 6.4, celsius: 61 },
  { name: msi, away, cores: away ? null : 24, busy: away ? null : 3, celsius: away ? null : 58 },
  { name: omarchy, away, cores: away ? null : 32, busy: away ? null : 12.2, celsius: away ? null : 70 },
];

/** Take local jobs until one waits; answers those admitted at once and the waiter. */
async function fillLocal(directory: string, label: string) {
  const held: HeldSlot[] = [];
  for (;;) {
    let waited = false, settled = false;
    const taking = acquireVerificationSlot({ directory, label: `${label}-${held.length + 1}`, project: 'acme/app', pollMs: 5, signal: stop.signal, onWait: () => { waited = true; } });
    taking.catch(() => {}).finally(() => { settled = true; });
    // The wait poll stops once the job is admitted, so no orphaned poll keeps the file running after its tests.
    const slot = await Promise.race([taking, until(() => waited || settled, 'the job waits', 30_000, 10).then(() => null)]);
    if (!slot) return { held, waiting: taking };
    held.push(slot);
  }
}
async function takeAll(directory: string, host: string) {
  const held: HeldSlot[] = [];
  for (let shard = 1; shard <= 40; shard++) { const slot = await takeHostSlot(directory, host, `test merge GY-1 shard ${shard}`, 'acme/app'); if (!slot) break; held.push(slot); }
  return held;
}

test('integration:scale-limits-with-hosts — a 24-core machine with ready hosts of 24 and 32 cores admits 4 local jobs and 37 host-placed shards at once; with the hosts away it admits 4; a limit file still sets the budget', { timeout: 120_000 }, async () => {
  const directory = join(await temporaryDirectory('scale-limits-with-hosts'), 'heavy-jobs');
  mkdirSync(directory);
  const localJobs = () => heldSlots(directory).filter(entry => entry.slot < gateSlot).length;
  // Before the loop has read any machine, the budget is two, as it was.
  assert.equal(heavyJobLimit(directory), 2);
  writeMachines(directory, machines(false));
  assert.deepEqual(readMachines(directory)?.map(machine => machine.name), ['vishrog', msi, omarchy]);

  const budget = heavyJobBudget(directory);
  assert.equal(budget.slots, 13);
  assert.equal(budgetLine(budget.machines), '13 heavy-job slots (this machine 4, vish-msi 4, omarchypc 5)');
  assert.equal(heavyJobLimit(directory), 4, 'this machine runs at most floor(24 / 6)');

  // Four local jobs run and the fifth waits; shards go to the hosts by free cores beside them (GY-3706).
  // The shards are placed first, each host's beside the other's, so the fifth local job's 5 ms poll does not run beside every host take.
  const [onMsi, onOmarchy] = await Promise.all([takeAll(directory, msi), takeAll(directory, omarchy)]);
  const first = await fillLocal(directory, 'merge trial');
  assert.equal(first.held.length, 4);
  assert.equal(onMsi.length, 19, 'vish-msi takes 24 cores less 2 less 3 busy');
  assert.equal(onOmarchy.length, 18, 'omarchypc takes 32 cores less 2 less 12.2 busy');
  assert.equal(heldSlots(directory).filter(entry => entry.slot >= hostSlot).length, 37);
  assert.equal(localJobs(), 4, 'host-placed shards never count against this machine');
  // A freed host slot is that host's again; a freed local slot admits the waiting local job.
  onMsi.pop()!.release();
  assert.ok(await takeHostSlot(directory, msi, 'test merge GY-2 shard 1'), 'vish-msi takes one more once one frees');
  first.held.pop()!.release();
  first.held.push(await first.waiting);
  assert.equal(localJobs(), 4);

  // Each machine's load, one line each; the loop's header carries each machine's slots to the Workers page.
  assert.deepEqual(readMachines(directory)!.map(machineLine), ['this machine: 6 of 24 cores busy, 61°C', 'vish-msi: 3 of 24 cores busy, 58°C', 'omarchypc: 12 of 32 cores busy, 70°C']);
  const header = loopHosts(encodeLoopHosts(hostsWithSlots(machines(false).map(machine => ({ host: machine.name, local: machine.local, away: machine.away, cores: machine.cores, busy: machine.busy, celsius: machine.celsius, steal: 0, runs: 0 })), heavyJobBudget(directory))))!;
  assert.deepEqual(header.map(host => host.slots), [4, 4, 5]);
  assert.equal(budgetLine(header.map(host => ({ name: host.host, local: host.local, slots: host.slots! }))), '13 heavy-job slots (this machine 4, vish-msi 4, omarchypc 5)');

  // With the hosts away the budget is this machine's four: no shard goes to a host, four local jobs run.
  for (const slot of [...onMsi, ...onOmarchy, ...first.held]) slot.release();
  for (const entry of heldSlots(directory)) rmSync(join(directory, `slot-${entry.slot}`), { recursive: true, force: true });
  writeMachines(directory, machines(true));
  assert.equal(heavyJobBudget(directory).slots, 4);
  assert.equal(budgetLine(heavyJobBudget(directory).machines), '4 heavy-job slots (this machine 4)');
  assert.equal(await takeHostSlot(directory, msi, 'test merge GY-3 shard 1'), null);
  assert.equal(await takeHostSlot(directory, omarchy, 'test merge GY-3 shard 2'), null);
  assert.deepEqual(readMachines(directory)!.map(machineLine).slice(1), ['vish-msi: away', 'omarchypc: away']);
  const away = await fillLocal(directory, 'merge trial away');
  assert.equal(away.held.length, 4);
  for (const slot of away.held) slot.release();
  (await away.waiting).release();

  // A limit file still sets the budget, and host shards are then bounded only by placement.
  writeMachines(directory, machines(false));
  // A host whose share is temporarily full under another trial is not dropped: overflow runs locally and the host is reused once a shard finishes.
  const busyOther = (await Promise.all(Array.from({ length: 18 }, (_, shard) => takeHostSlot(directory, msi, `other ${shard + 1}`)))).filter(slot => slot !== null);
  assert.equal(busyOther.length, 18, 'another trial leaves vish-msi one free shard');
  const placed: PlacedHost<string>[] = [
    { name: 'vishrog', room: 1, reading: { name: 'vishrog', cores: 24, busy: 0, steal: 0, celsius: 60, limit: 85, away: false } },
    { name: msi, remote: msi, room: 4, reading: { name: msi, cores: 24, busy: 0, steal: 0, celsius: 58, limit: 85, away: false } },
  ];
  let msiRuns = 0, releaseMsi1!: () => void, releaseLocal1!: () => void;
  const msi1Wait = new Promise<void>(done => { releaseMsi1 = done; }), local1Wait = new Promise<void>(done => { releaseLocal1 = done; });
  let localStarted = false, msi1Started = false;
  const placement = await runShardsOnHosts({
    count: 3, hosts: placed, breadth: 1,
    run: async (host, index) => {
      if (host.remote) {
        const held = await takeHostSlot(directory, host.remote, `test merge GY-5 shard ${index + 1}`, 'acme/app');
        if (!held) throw new HostBusyError(host.remote);
        const run = ++msiRuns;
        try {
          if (run === 1) { msi1Started = true; if (localStarted) releaseMsi1(); await msi1Wait; }
          else releaseLocal1();
        } finally { held.release(); }
      } else {
        localStarted = true;
        if (msi1Started) releaseMsi1();
        await local1Wait;
      }
    },
  });
  assert.deepEqual(placement.dropped, [], 'a full host share is never treated as a dropped host');
  assert.equal(placement.ran.filter(name => name === msi).length, 2, `vish-msi is reused after a shard frees its slot: ${placement.ran.join(', ')}`);
  for (const slot of busyOther) slot.release();

  writeFileSync(join(directory, 'limit'), '3\n');
  assert.equal(heavyJobLimit(directory), 3);
  assert.equal(heavyJobBudget(directory).slots, 3);
  assert.ok(await takeHostSlot(directory, msi, 'test merge GY-4 shard 1'));
});

test('integration:scale-limits-with-hosts — a worker verification slot is freed within one loop cycle once its request finished, or its lease is gone; one with a running child or an active request is kept', { timeout: 120_000 }, async () => {
  const scratch = await temporaryDirectory('verification-frees-slot'), directory = join(scratch, 'heavy-jobs'), root = join(scratch, 'repo');
  mkdirSync(directory);
  writeFileSync(join(directory, 'limit'), '4\n');
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = directory;
  try {
    mkdirSync(root);
    const { git } = await gitRepo({ root });
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
    const head = git('rev-parse', 'HEAD');
    git('branch', 'graphyard/gy-1');
    const take = (key: string) => acquireVerificationSlot({ directory, label: workerVerificationLabel(key), project: 'acme/app', pollMs: 5 });
    const holding = () => heldSlots(directory).filter(entry => entry.slot < gateSlot).map(entry => entry.owner!.label).sort();

    // GY-1's request runs through the pump and holds its slot until the test lets it go.
    let finishGy1!: () => void;
    const gy1Done = new Promise<void>(done => { finishGy1 = done; });
    const finished: unknown[] = [];
    let jobs = [{ id: 'r1', host: 'h', branch: 'graphyard/gy-1', baseBranch: 'main', work: { key: 'GY-1' }, input: { head, epoch: 1, mode: 'verify' } }];
    const mutate = async (path: string, body: unknown) => {
      if (path === 'worker-verifications/take') { const taken = jobs; jobs = []; return taken; }
      if (path === 'worker-verifications/finish') finished.push(body);
      return {};
    };
    const verify = (async () => { const held = await take('GY-1'); try { await gy1Done; return { ok: true }; } finally { held.release(); } }) as never;
    const pump = workerVerificationPump(root, () => 'h', mutate, () => root, undefined, verify);
    await pump([]);
    await until(() => holding().includes(workerVerificationLabel('GY-1')), 'GY-1 holds its slot', 30_000, 10);
    // GY-2 finished but its slot was left; GY-3 has a child running.
    await take('GY-2');
    await take('GY-3');
    runningVerificationChildren.set('GY-3', 1);
    await take('GY-5');
    // A queued job waits behind the four held slots.
    let admitted = false;
    const queued = acquireVerificationSlot({ directory, label: 'merge trial GY-9', project: 'acme/other', pollMs: 5 }).then(slot => { admitted = true; return slot; });
    await sleep(100);
    assert.ok(!admitted, 'the budget is spent');

    // One cycle with GY-1 under a live lease: only the finished GY-2 and the lease-less GY-5 are freed.
    const leased = { lease: { attemptId: 'a' } } as never;
    await pump([{ key: 'GY-1', ...leased as object } as never, { key: 'GY-5', lease: null } as never]);
    assert.deepEqual(holding().filter(label => label.startsWith('worker')), ['GY-1', 'GY-3'].map(workerVerificationLabel));
    const freed = await queued;
    assert.ok(admitted, 'a freed slot admits the queued job');
    freed.release();

    // GY-1's lease goes while its request still runs, with no child: freed at the next cycle.
    await pump([{ key: 'GY-1', lease: null } as never]);
    assert.ok(!holding().includes(workerVerificationLabel('GY-1')));
    // A new job reuses the freed slot number; when GY-1's original job later finishes and calls release(), it must not delete the new holder's live slot.
    const reused = await acquireVerificationSlot({ directory, label: 'merge trial GY-10', project: 'acme/other', pollMs: 5 });
    // The child keeps its slot until it settles.
    assert.deepEqual(holding().filter(label => label.startsWith('worker')), ['GY-3'].map(workerVerificationLabel));
    runningVerificationChildren.delete('GY-3');
    await pump([]);
    finishGy1();
    await until(() => finished.length === 1, 'GY-1 reports its result', 30_000, 10);
    assert.deepEqual(holding(), ['merge trial GY-10'], 'late release from a reclaimed verification slot leaves the new holder intact');
    reused.release();
    assert.deepEqual(holding(), []);
  } finally {
    if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous;
  }
});

test('integration:scale-limits-with-hosts — master status shows the budget and each machine\'s cores busy and temperature, one short line each, with no internal ids', { timeout: 60_000 }, async () => {
  const root = await temporaryDirectory('scale-limits-status'), directory = join(await temporaryDirectory('scale-limits-status-data'), 'heavy-jobs');
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, '.graphyard'));
  const credentialFile = join(root, 'token');
  writeFileSync(credentialFile, 'fixture-token', { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', cliPath: process.execPath, repository: 'acme/app', baseBranch: 'main', hostId: 'loop-host',
    masterAgentName: 'graphyard-master-app', workers: [], credentialFile, run: {} }) as never;
  writeFileSync(join(root, '.graphyard/master.json'), JSON.stringify(master), { mode: 0o600 });
  writeMachines(directory, machines(false));
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = directory;
  try {
    const shown = await masterStatusReport(root, master, async () => ({ work: [], now: new Date().toISOString() }), async () => { throw new Error('no git in the fixture'); });
    assert.equal(shown.heavyJobs.budget, '13 heavy-job slots (this machine 4, vish-msi 4, omarchypc 5)');
    assert.deepEqual(shown.heavyJobs.machines, ['this machine: 6 of 24 cores busy, 61°C', 'vish-msi: 3 of 24 cores busy, 0 shards, 58°C', 'omarchypc: 12 of 32 cores busy, 0 shards, 70°C']);
    for (const line of [shown.heavyJobs.budget, ...shown.heavyJobs.machines]) { assert.doesNotMatch(line, /gy-compute|@|:\d{4}/); assert.ok(line.length <= 80, line); }
  } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
});
