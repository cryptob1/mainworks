import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master/profiles.js';
import { describeHumanRequest } from '../src/model/human-request.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3996 AC-2: an item that is ready, has an open blocker, has no live session and has not changed
// for 60 minutes is reported by the stall alarm with its key, the blocker's first 120 characters and
// its age, and is included in the coordinator's wake message once per hour while it lasts; master
// status no longer reports stallAlarm: null in that state. Items blocked on a human request or an open
// scope request are excluded. Clearing the blocker clears the alarm and dispatches in the next cycle.

const proof = 'integration:ready-item-with-stale-blocker-raises-the-stall-alarm';
const start = Date.parse('2026-11-27T05:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const longBlocker = 'Drift check stopped attempt 1 because deploy/legacy.pin pointed to an older build hash that had not yet been rolled forward across the staging cluster.';
assert.ok(longBlocker.length > 120);

function blockedReadyItem(key: string, fields: Partial<Work> = {}): Work {
  return workFixture({
    id: `id-${key}`, key, title: `Stale blocked ${key}`, stage: 'ready', ready: true,
    epoch: 1, revision: 3, policyRevision: 1, priority: 1, type: 'bug',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    dependencies: [], evidence: [], gates: [], workspaces: [], sessions: [],
    blocker: longBlocker, blockedAt: iso(start),
    createdAt: iso(start - 30 * minute), updatedAt: iso(start), stageEnteredAt: iso(start),
    ...fields,
  });
}

async function fixture(initialWork: Work[]) {
  const directory = await temporaryDirectory('stale-blocker-stall');
  const profile = { name: 'w1', principal: 'worker-a', agentName: 'agent-w1', mode: 'launch', kind: 'claude', credentialFile: '/outside/w1.token', agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const config: MasterConfig = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', repository: 'owner/stale-blocker',
    credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard',
    hostId: 'stall-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master',
    workers: [profile], run: { masterHeartbeatMinutes: 240 },
  });
  const state = emptyDaemonState(config);
  state.lock = { id: 'lock', pid: 1, host: 'stall-host', startedAt: iso(start), heartbeatAt: iso(start) };
  let now = start, work = initialWork;
  const prompts: string[] = [], dispatched: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: iso(now) }),
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    credentials: async () => ({ w1: { available: true, reason: null } }),
    closeSession: () => {},
    persist: async () => {},
    dispatch: async item => {
      dispatched.push(item.key);
      work = work.map(entry => entry.key === item.key ? {
        ...entry, stage: 'build',
        sessions: [{ id: 'worker-a:2', kind: 'implementation', state: 'running', principal: 'worker-a', host: 'stall-host', startedAt: iso(now) }],
      } as unknown as Work : entry);
      return { pane: 'p1', epoch: 2 };
    },
    masterSession: {
      wake: async (_target, text) => { prompts.push(text); },
      launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'a', session: 's' }),
    },
  };
  return {
    config, state, prompts, dispatched,
    setWork: (next: Work[]) => { work = next; },
    cycle: () => runCycle(config, state, effects, () => now),
    advance: (minutes: number) => { now += minutes * minute; },
    status: async () => {
      await writeFile(daemonStatePath(config), JSON.stringify(state));
      const root = await temporaryDirectory('stale-blocker-status');
      execFileSync('git', ['init', '-q', root]);
      const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'c'.repeat(40)}\n`;
      return masterStatusReport(root, config, (async (path: string) => path === 'work-snapshot' ? { work, now: iso(now) } : { messages: [] }) as any, run);
    },
  };
}

const alarmOf = (state: DaemonState) => state.actions[stallAlarmKey]?.detail;

test(`${proof} — a ready item with an open blocker, no live session and no change for 60 minutes raises the stall alarm, appears in master status, and wakes the coordinator once per hour`, async () => {
  const item = blockedReadyItem('GY-218');
  // An item parked on a human decision carries the request and the blocker the park wrote beside it.
  const parkedRequest = { id: 'hr-1', kind: 'goals-and-priorities' as const, reason: 'Two fixes conflict', needed: 'Choose priority', requestedBy: 'worker-a', epoch: 1, at: iso(start), answer: null };
  const humanBlocked = blockedReadyItem('GY-219', { humanRequest: parkedRequest, blocker: describeHumanRequest(parkedRequest) });
  const scopeBlocked = blockedReadyItem('GY-220', {
    agentRequests: [{ id: 'sr-1', type: 'scope-request' as any, epoch: 1, requestedBy: 'worker-a', at: iso(start), reason: 'Need extra file', decider: { kind: 'rule', who: 'master', command: null }, releasedLease: true, state: 'open' }],
  });
  const f = await fixture([item, humanBlocked, scopeBlocked]);

  // Before 60 minutes: no stall alarm.
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'no stall alarm at 0 minutes');
  f.advance(59);
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'no stall alarm at 59 minutes');
  const promptsBeforeStall = f.prompts.length;

  // At 60 minutes: stall alarm fires for GY-218 only (excluding human and scope requests) and wakes the coordinator once.
  f.advance(1);
  await f.cycle();
  const alarm = alarmOf(f.state);
  assert.ok(alarm, 'stall alarm fires at 60 minutes');
  assert.ok(alarm.includes('GY-218'), `alarm names the item key: ${alarm}`);
  assert.ok(alarm.includes(longBlocker.slice(0, 120)), `alarm names the first 120 chars of the blocker: ${alarm}`);
  assert.equal(alarm.includes(longBlocker), false, 'alarm caps blocker text at 120 characters');
  assert.ok(alarm.includes('(1h)'), `alarm includes the blocker age: ${alarm}`);
  assert.equal(alarm.includes('GY-219'), false, 'item blocked on an open human request is excluded');
  assert.equal(alarm.includes('GY-220'), false, 'item blocked on an open scope request is excluded');

  // master status reports the stall alarm (not null).
  const report = await f.status();
  assert.equal(report.stallAlarm, alarm, 'master status carries the stall alarm');

  // The coordinator's wake message carries the alarm, once: nothing wakes it again within the hour.
  assert.equal(f.prompts.length, promptsBeforeStall + 1, 'coordinator woken once when the stall alarm fires');
  assert.ok(f.prompts.at(-1)!.includes('GY-218') && f.prompts.at(-1)!.includes(longBlocker.slice(0, 120)));

  f.advance(15);
  await f.cycle();
  assert.equal(alarmOf(f.state), alarm, 'the line holds still within the hour: nothing new to store, log or wake for');
  f.advance(30);
  await f.cycle();
  assert.equal(f.prompts.length, promptsBeforeStall + 1, 'no duplicate wake while under an hour since last wake');

  // After a full hour (60 minutes since first wake): woken once more, the line now reading the older age.
  f.advance(15);
  await f.cycle();
  assert.equal(f.prompts.length, promptsBeforeStall + 2, 'coordinator woken again once per hour while it lasts');
  assert.ok(alarmOf(f.state)!.includes('(2h)'), `the alarm reads the blocker's age: ${alarmOf(f.state)}`);
  assert.ok(f.prompts.at(-1)!.includes('GY-218') && f.prompts.at(-1)!.includes(longBlocker.slice(0, 120)));
});

test(`${proof} — clearing the blocker clears the stall alarm and dispatches the item in the next cycle`, async () => {
  const item = blockedReadyItem('GY-218');
  const f = await fixture([item]);
  f.advance(65);
  await f.cycle();
  assert.ok(alarmOf(f.state)?.includes('GY-218'), 'stall alarm stands while the blocker is open');
  assert.deepEqual(f.dispatched, [], 'blocked item is not dispatched');

  // Clear the blocker and run the next cycle.
  f.setWork([{ ...item, blocker: null, blockedAt: null, updatedAt: iso(start + 66 * minute) }]);
  f.advance(1);
  await f.cycle();
  assert.deepEqual(f.dispatched, ['GY-218'], 'unblocked item dispatches in the next cycle');
  assert.equal(alarmOf(f.state), undefined, 'stall alarm clears once the blocker is cleared');
});
