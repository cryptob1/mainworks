// GY-3864: a busy install still takes a new verified build within four hours of its last
// successful update (control.updatedAt); failed restarts keep that clock, retry on the next pass,
// and show one attention line naming the failed step and the build.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  controlPlaneRecordPath,
  controlPlaneUpdateAttention,
  deployOnce,
  deployRecordPath,
  readControlPlaneRecord,
  readDeployRecord,
  updateNowPath,
  updateWait,
  type ControlPlaneRecord,
} from '../src/deploy-watch.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { mainworksRepository } from '../src/scenarios.js';
import { deployPorts } from './helpers/deploy-ports.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const sha = (hex: string) => hex.repeat(40);
const minute = 60_000, start = Date.parse('2026-11-25T16:00:00.000Z');

test('unit:forced-update-counts-from-last-update — updateWait measures the 4-hour cap from control.updatedAt even as busy work, changing tips and replaced wait records arrive', async t => {
  mock.timers.enable({ apis: ['Date'], now: start });
  t.after(() => mock.timers.reset());
  const root = await temporaryDirectory('forced-update-wait');
  const nowFile = updateNowPath(root);
  const updatedAt = new Date(start).toISOString();
  const baseControl = (over: Partial<ControlPlaneRecord> = {}): ControlPlaneRecord => ({
    commit: sha('0'), checkedAt: updatedAt, updatedAt, verified: sha('0'), verifiedSeenAt: updatedAt,
    failedStep: null, failedReason: null, failedAt: null, waiting: null, at: updatedAt, ...over,
  });

  // Under 4 hours: a busy port holds the update even as tips change and wait records are replaced.
  for (const [elapsedMinutes, busy, tip] of [
    [60, 'a review is running', sha('1')],
    [120, 'a merge trial is running', sha('2')],
    [180, 'an acceptance run is running', sha('3')],
    [239, 'a review is running', sha('4')],
  ] as const) {
    mock.timers.setTime(start + elapsedMinutes * minute);
    const replacedWait = { tip, since: new Date(Date.now()).toISOString(), reason: `update to ${tip.slice(0, 12)} waits` };
    const waiting = await updateWait(tip, sha('0'), { busy: async () => busy, hotfix: async () => false }, baseControl({ waiting: replacedWait }), nowFile);
    assert.ok(waiting, `still waits at ${elapsedMinutes} minutes while ${busy}`);
    assert.equal(waiting.tip, tip);
  }

  // At 4 hours from updatedAt: updates immediately even with a busy port and a brand-new wait record.
  mock.timers.setTime(start + 240 * minute);
  const freshWait = { tip: sha('4'), since: new Date(Date.now()).toISOString(), reason: 'just started waiting' };
  assert.equal(
    await updateWait(sha('4'), sha('0'), { busy: async () => 'a review is running', hotfix: async () => false }, baseControl({ waiting: freshWait }), nowFile),
    null,
    'takes the build at 4 hours from updatedAt even when waiting.since was just replaced',
  );
  assert.equal(
    await updateWait(sha('4'), sha('0'), { busy: async () => 'a merge trial is running', hotfix: async () => false }, baseControl({ waiting: null }), nowFile),
    null,
    'takes the build at 4 hours from updatedAt even when waiting was cleared',
  );

  // Hotfix and `master update now` remain unchanged under 4 hours while busy.
  mock.timers.setTime(start + 10 * minute);
  assert.equal(
    await updateWait(sha('5'), sha('0'), { busy: async () => 'a review is running', hotfix: async () => true }, baseControl(), nowFile),
    null,
    'hotfix still applies at once while busy',
  );
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(nowFile, new Date().toISOString());
  assert.equal(
    await updateWait(sha('6'), sha('0'), { busy: async () => 'a review is running', hotfix: async () => false }, baseControl(), nowFile),
    null,
    'master update now still applies at once while busy',
  );
});

test('unit:forced-update-counts-from-last-update — with busy work always in flight and a newer verified tip every hour, deployOnce takes the newest verified build at 4 hours from updatedAt', async t => {
  mock.timers.enable({ apis: ['Date'], now: start });
  t.after(() => mock.timers.reset());
  const advance = (minutes: number) => mock.timers.tick(minutes * minute);

  const root = await temporaryDirectory('forced-update-busy'), file = deployRecordPath(root);
  let upstream = sha('1'), busy: string | null = null;
  const restarts: string[] = [];
  const ports = deployPorts(() => upstream, sha('0'), {
    verifiedUpstream: async () => upstream,
    busy: async () => busy, hotfix: async () => false,
    restart: async commit => { restarts.push(commit); },
  });
  const pass = () => deployOnce(file, ports, () => {}, mainworksRepository);

  // Initial quiet update sets updatedAt.
  assert.equal(await pass(), 'deployed');
  const firstUpdate = readControlPlaneRecord(controlPlaneRecordPath(root))?.updatedAt;
  assert.ok(firstUpdate);

  // A newer verified tip arrives every hour while a review, merge trial or acceptance run is always in flight.
  advance(60); upstream = sha('2'); busy = 'a review is running';
  assert.equal(await pass(), 'unchanged');
  advance(60); upstream = sha('3'); busy = 'a merge trial is running';
  assert.equal(await pass(), 'unchanged');
  advance(60); upstream = sha('4'); busy = 'an acceptance run is running';
  assert.equal(await pass(), 'unchanged');
  advance(59); upstream = sha('5'); busy = 'a review is running';
  assert.equal(await pass(), 'unchanged', 'still waits at 3h59m from updatedAt');

  // At 4 hours from updatedAt, the install takes the newest verified build despite busy work.
  advance(1);
  assert.equal(await pass(), 'deployed', 'takes the newest verified build at 4h from updatedAt');
  assert.equal(readDeployRecord(file)?.tip, sha('5'));
  assert.deepEqual(restarts, [sha('1'), sha('5')]);
  assert.equal(readControlPlaneRecord(controlPlaneRecordPath(root))?.waiting, null);
  assert.notEqual(readControlPlaneRecord(controlPlaneRecordPath(root))?.updatedAt, firstUpdate);
});

test('unit:forced-update-counts-from-last-update — two failed restarts keep updatedAt, retry on the next pass, show one status attention line naming the failed step and build, and clear it on success', async t => {
  mock.timers.enable({ apis: ['Date'], now: start });
  t.after(() => mock.timers.reset());
  const advance = (minutes: number) => mock.timers.tick(minutes * minute);

  const root = await temporaryDirectory('forced-update-failed-restart'), file = deployRecordPath(root);
  let upstream = sha('1'), running = sha('0'), busy: string | null = null, remainingFailures = 0;
  const restartAttempts: string[] = [];
  const ports = deployPorts(() => upstream, sha('0'), {
    verifiedUpstream: async () => upstream,
    busy: async () => busy, hotfix: async () => false,
    restart: async commit => {
      restartAttempts.push(commit);
      if (commit === upstream && remainingFailures > 0) {
        remainingFailures--;
        throw new Error('docker compose up timed out');
      }
      running = commit;
    },
    health: async commit => { if (running !== commit) throw new Error(`serves ${running.slice(0, 12)}`); },
  });
  const pass = () => deployOnce(file, ports, () => {}, mainworksRepository);
  const control = () => readControlPlaneRecord(controlPlaneRecordPath(root))!;
  const config = {
    url: 'http://127.0.0.1:5', repository: 'owner/consumer', credentialFile: join(root, 'coordinator.token'),
    hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 },
  } as unknown as MasterConfig;
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(daemonStatePath(config), JSON.stringify(emptyDaemonState(config)));
  const status = () => masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), async () => `${sha('1')}\n`);

  // Initial update establishes updatedAt.
  assert.equal(await pass(), 'deployed');
  const firstUpdate = control().updatedAt;
  assert.ok(firstUpdate);

  // 4 hours later, still busy, a new build arrives whose restart fails twice before succeeding.
  advance(240);
  upstream = sha('2');
  busy = 'a review is running';
  remainingFailures = 2;

  // First failed restart: rolled back, updatedAt does not move, status shows one attention line naming restart and the build.
  assert.equal(await pass(), 'rolled-back');
  assert.equal(readDeployRecord(file)?.tip, sha('1'));
  assert.equal(control().updatedAt, firstUpdate, 'failed restart #1 does not move updatedAt');
  assert.equal(control().failedStep, 'restart');
  assert.equal(controlPlaneUpdateAttention(control()).length, 1);
  {
    const report = await status();
    const lines = report.attention.filter(line => line.subject === 'control plane update');
    assert.equal(lines.length, 1, 'status shows one attention line after failed restart #1');
    assert.match(lines[0]!.text, /restart/);
    assert.match(lines[0]!.text, new RegExp(sha('2').slice(0, 12)));
  }

  // Next eligible pass (5m backoff, still busy): retries instead of starting a new 4-hour wait, fails a second time.
  advance(5);
  busy = 'a merge trial is running';
  assert.equal(await pass(), 'rolled-back');
  assert.equal(control().updatedAt, firstUpdate, 'failed restart #2 does not move updatedAt');
  assert.equal(control().failedStep, 'restart');
  {
    const report = await status();
    const lines = report.attention.filter(line => line.subject === 'control plane update');
    assert.equal(lines.length, 1, 'status still shows one attention line after failed restart #2');
    assert.match(lines[0]!.text, /restart/);
    assert.match(lines[0]!.text, new RegExp(sha('2').slice(0, 12)));
  }

  // Next eligible pass (15m backoff, still busy): retries and succeeds, advancing updatedAt and clearing the attention line.
  advance(15);
  busy = 'an acceptance run is running';
  assert.equal(await pass(), 'deployed');
  assert.equal(readDeployRecord(file)?.tip, sha('2'));
  assert.notEqual(control().updatedAt, firstUpdate, 'successful update advances updatedAt');
  assert.equal(control().failedStep, null);
  assert.deepEqual(controlPlaneUpdateAttention(control()), []);
  {
    const report = await status();
    const lines = report.attention.filter(line => line.subject === 'control plane update');
    assert.deepEqual(lines, [], 'status clears the attention line after success');
  }
  assert.equal(restartAttempts.filter(commit => commit === sha('2')).length, 3, 'two failed restarts followed by one success');
});
