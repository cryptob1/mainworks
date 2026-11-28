import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';
import { deriveNotMoving } from '../src/daemon/stall-alarm.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { requestHeavyDrain, resumeHeavyDrain, slotsDirectoryVariable, waitStep } from '../src/master/verification-slots.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { isHerdrCommand } from '../src/master/herdr.js';

test('integration:not-moving-quiet-while-drained', async t => {
  const root = await temporaryDirectory('not-moving-drain');
  const slots = join(root, 'slots');
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = slots;
  t.after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });
  execFileSync('git', ['init', '-q', root]);
  const min = 60_000;
  let clock = Date.now();
  const stale = new Date(clock - 45 * min).toISOString();
  const work = [
    workFixture({ key: 'GY-1', stage: 'test', stageEnteredAt: stale }),
    workFixture({ key: 'GY-2', stage: 'build', stageEnteredAt: stale }),
    workFixture({ key: 'GY-3', stage: 'build', stageEnteredAt: stale, lease: { owner: 'builder', epoch: 1, expiresAt: new Date(clock + 120 * min).toISOString() } }),
  ];
  // An intent is recorded before heavyTrial can take its slot. Neither the
  // initial intent nor its subsequent slot-wait step means the trial is running.
  for (const key of ['GY-8', 'GY-9']) work.push(workFixture({ key, stage: 'test', stageEnteredAt: stale, mergeLedger: {
    key, state: 'intent', head: null, baseTip: null, mergeSha: null, risk: null,
    intentAt: stale, pushedAt: null, observedTip: null, refusal: null, events: 1,
    ...(key === 'GY-9' ? { trialStep: { step: waitStep(slots), at: stale } } : {}),
  } }));
  let cap = 0;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://example.test', repository: 'owner/project', credentialFile: join(root, 'token'), cliPath: '/bin/mainworks', hostId: 'host', baseBranch: 'main', masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const state = emptyDaemonState(config);
  const wakes: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(clock).toISOString(), workerVerifications: [{ key: 'GY-3', host: 'host', state: 'queued' }] }),
    flow: async () => ({ notMoving: deriveNotMoving(work, clock).notMoving.map(item => item.key === 'GY-1' ? { ...item, owner: 'nobody' as const } : item) }),
    registry: async () => ({ runtimes: [], accounts: [], sessions: [], roles: [{ name: 'worker', accounts: [], concurrency: cap }] }) as any,
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => ({}), persist: async () => {},
    masterSession: { wake: async (_target, text) => { wakes.push(text); }, launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'a', session: 's' }) },
  };
  requestHeavyDrain(slots, 'Lead quiet window', 'lead');
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(wakes, [], 'paused trials and builder launches send no alarm past the delay');
  const report = await masterStatusReport(root, config, async path => path === 'work-snapshot' ? { work, now: new Date(clock).toISOString() } : path === 'not-moving' ? deriveNotMoving(work, clock) : path.startsWith('agent-registry') ? { runtimes: [], accounts: [], roles: [{ role: 'worker', accounts: [], concurrency: cap }] } : { messages: [] }, async command => isHerdrCommand(command) ? JSON.stringify({ agents: [] }) : `${'c'.repeat(40)}\n`);
  assert.equal((report as any).heavyDrain.reason, 'Lead quiet window');
  assert.equal((report as any).workers, '0/0');
  resumeHeavyDrain(slots);
  await runCycle(config, state, effects, () => clock);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0]!, /GY-1/);
  assert.match(wakes[0]!, /GY-8/, 'an intent without a started trial alarms after resume');
  assert.match(wakes[0]!, /GY-9/, 'an intent waiting for a heavy slot alarms after resume');
  assert.match(wakes[0]!, /GY-3/, 'queued checks alarm again after resume');
  assert.doesNotMatch(wakes[0]!, /GY-2/);
  cap = 1;
  await runCycle(config, state, effects, () => clock);
  assert.equal(wakes.length, 2);
  assert.match(wakes[1]!, /GY-2/);
  clock += 60 * min;
  await runCycle(config, state, effects, () => clock);
  assert.equal(wakes.length, 3, 'still-stuck items repeat after the usual hour');
  assert.match(wakes[2]!, /GY-1/);
  assert.match(wakes[2]!, /GY-2/);
  requestHeavyDrain(slots, 'Another quiet window', 'lead');
  cap = 0;
  work.push(
    workFixture({ key: 'GY-4', stage: 'review', stageEnteredAt: stale }),
    workFixture({ key: 'GY-5', stage: 'build', stageEnteredAt: stale, lease: { owner: 'builder', epoch: 1, expiresAt: new Date(clock + 120 * min).toISOString() } }),
    workFixture({ key: 'GY-6', stage: 'ready', stageEnteredAt: stale }),
    workFixture({ key: 'GY-7', stage: 'test', stageEnteredAt: stale, mergeLedger: {
      key: 'GY-7', trialStep: { step: 'build', at: stale }, state: 'intent', head: null, baseTip: null, mergeSha: null, risk: null,
      intentAt: stale, pushedAt: null, observedTip: null, refusal: null, events: 1,
    } }),
  );
  await runCycle(config, state, effects, () => clock);
  assert.equal(wakes.length, 4);
  assert.match(wakes[3]!, /GY-4/, 'a drain does not hide a stalled review');
  assert.match(wakes[3]!, /GY-5/, 'a zero launch cap does not hide an existing builder');
  assert.match(wakes[3]!, /GY-7/, 'a drain does not hide an already running trial');
  assert.doesNotMatch(wakes[3]!, /GY-[123689] /, 'only intentionally paused work stays quiet');
});
