// GY-3746: an install following Mainworks's verified builds takes a newer one at a quiet moment, at
// most once an hour, and anyway after 4 hours; the install building Mainworks itself updates as before.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { controlPlaneRecordPath, controlPlaneSummary, deployOnce, deployRecordPath, readControlPlaneRecord, readDeployRecord, updateNowPath, type DeployWatchPorts } from '../src/deploy-watch.js';
import { mainworksRepository } from '../src/scenarios.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const minute = 60_000, start = Date.parse('2026-11-23T12:00:00.000Z');

async function install(core = false) {
  const root = await temporaryDirectory('consumer-quiet'), file = deployRecordPath(root);
  let upstream = b, busy: string | null = null, titles = 'Merge GY-1: a change';
  const restarts: string[] = [];
  const ports: DeployWatchPorts = {
    fetch: async () => c, head: async () => a, verifiedUpstream: async () => upstream,
    busy: async () => busy, hotfix: async () => /\bhotfix:/i.test(titles),
    build: async () => {}, restart: async commit => { restarts.push(commit); }, health: async () => {},
    checkout: async () => {}, pin: async () => {}, prune: async () => {}, schema: async () => 1, database: async () => 1,
  };
  if (core) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${dirname(file)}/main-gate.json`, JSON.stringify({ repository: mainworksRepository, verified: b }));
  }
  const pass = () => deployOnce(file, ports, () => {}, mainworksRepository);
  return { root, file, restarts, pass, set: (next: { upstream?: string; busy?: string | null; titles?: string }) => {
    if (next.upstream) upstream = next.upstream; if (next.busy !== undefined) busy = next.busy; if (next.titles) titles = next.titles;
  } };
}

test('unit:consumer-install-updates-when-quiet — a second build 20 minutes later waits; a quiet moment after 61 minutes updates; busy for 4 hours updates; hotfix and update now apply at once; the core install is unchanged', async t => {
  mock.timers.enable({ apis: ['Date'], now: start });
  t.after(() => mock.timers.reset());
  const advance = (minutes: number) => mock.timers.tick(minutes * minute);

  // First build: a long-idle install takes it at a quiet moment.
  const one = await install();
  assert.equal(await one.pass(), 'deployed');
  assert.equal(readDeployRecord(one.file)?.tip, b);

  // A second build 20 minutes later waits, and master status names it and why.
  advance(20);
  one.set({ upstream: c });
  assert.equal(await one.pass(), 'unchanged');
  assert.deepEqual(one.restarts, [b], 'no restart 20 minutes after the last update');
  assert.equal(controlPlaneSummary(readControlPlaneRecord(controlPlaneRecordPath(one.root)), Date.now())?.waiting, `update to ${c.slice(0, 12)} waits: last update 20 minutes ago`);

  // Busy at 61 minutes still waits, naming the review; quiet at 61 minutes updates.
  advance(41);
  one.set({ busy: 'a review is running' });
  assert.equal(await one.pass(), 'unchanged');
  assert.equal(controlPlaneSummary(readControlPlaneRecord(controlPlaneRecordPath(one.root)), Date.now())?.waiting, `update to ${c.slice(0, 12)} waits: a review is running, last update 61 minutes ago`);
  one.set({ busy: null });
  assert.equal(await one.pass(), 'deployed');
  assert.deepEqual(one.restarts, [b, c]);
  assert.equal(controlPlaneSummary(readControlPlaneRecord(controlPlaneRecordPath(one.root)), Date.now())?.waiting, null);

  // Busy for 4 hours since the last update: the build waits, then updates anyway.
  const d = 'd'.repeat(40);
  advance(90);
  one.set({ upstream: d, busy: 'a merge trial is running' });
  assert.equal(await one.pass(), 'unchanged');
  advance(149);
  assert.equal(await one.pass(), 'unchanged', 'still busy short of 4 hours since the last update');
  advance(1);
  assert.equal(await one.pass(), 'deployed', 'at 4 hours since the last update it updates anyway');
  assert.deepEqual(one.restarts, [b, c, d]);

  // A hotfix-titled build applies at once, even busy and minutes after the last update.
  const e = 'e'.repeat(40);
  advance(5);
  one.set({ upstream: e, titles: 'Merge GY-2: Hotfix: the deploy retries' });
  assert.equal(await one.pass(), 'deployed');
  // `master update now` skips the wait once.
  const f = 'f'.repeat(40);
  advance(5);
  one.set({ upstream: f, titles: 'Merge GY-3: a change' });
  assert.equal(await one.pass(), 'unchanged');
  await writeFile(updateNowPath(one.root), new Date().toISOString());
  assert.equal(await one.pass(), 'deployed');
  assert.deepEqual(one.restarts, [b, c, d, e, f]);

  // The install building Mainworks itself serves its gate's verified commit as today: no wait, even busy.
  const core = await install(true);
  core.set({ busy: 'a review is running' });
  assert.equal(await core.pass(), 'deployed');
  advance(2);
  await writeFile(`${dirname(core.file)}/main-gate.json`, JSON.stringify({ repository: mainworksRepository, verified: c }));
  assert.equal(await core.pass(), 'deployed', 'the core install updates two minutes later while busy');
  assert.deepEqual(core.restarts, [b, c]);
});
