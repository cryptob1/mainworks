import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveNotMoving, formatNotMovingLines, type NotMovingItem } from '../src/daemon/stall-alarm.js';
import { emptyDaemonState, daemonStatePath } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { notMovingLines } from '../web/lead-feed.js';
import MasterPage from '../web/pages/master.js';
import type { Work } from '../src/model.js';
import type { FlowEvent } from '../src/flow-numbers.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

const min = 60_000;
const hr = 60 * min;
const now = Date.parse('2026-11-27T12:00:00Z');
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

function finishedWithStageDurations(count: number, stageDurationsMs: Record<string, number>) {
  const work: Work[] = [];
  const events = new Map<string, FlowEvent[]>();
  for (let i = 1; i <= count; i++) {
    const id = `done-${i}`;
    const mergedAt = at(-i * 10 * min);
    work.push(workFixture({
      id, key: `GY-D${i}`, title: `Finished ${i}`, stage: 'done', ready: false,
      stageEnteredAt: mergedAt, delivery: { mergedAt, mergeSha: 'a'.repeat(40), authorizationRevision: 1 } as Work['delivery'],
    }));
    const list: FlowEvent[] = [];
    let cursor = Date.parse(mergedAt);
    const ordered = Object.entries(stageDurationsMs).reverse();
    for (const [stage, dur] of ordered) {
      cursor -= dur;
      list.unshift({ kind: 'stage', at: new Date(cursor).toISOString(), stage });
    }
    list.push({ kind: 'merge', at: mergedAt, stage: 'done' });
    events.set(id, list);
  }
  return { work, events };
}

test('unit:not-moving-is-judged-by-time-and-owner-not-cause — stale blocker, live review inside and over 3x median, backed-off action past retryAt, and human request listed apart', () => {
  // 50 finished items: review median = 20m (3x = 60m), build median = 100m (3x = 300m -> capped at 4h = 240m), ready median = 5m (3x = 15m -> floored at 30m).
  const { work: finished, events } = finishedWithStageDurations(50, { ready: 5 * min, build: 100 * min, review: 20 * min });

  // 1. Ready item with a stale blocker and no session (owner nobody, > 30m -> reported).
  const staleBlocker = workFixture({
    id: 'w-blocker', key: 'GY-101', title: 'Stale blocked ready item', stage: 'ready', ready: true,
    stageEnteredAt: at(-90 * min), updatedAt: at(-1 * min), blocker: 'old env blocker', blockedAt: at(-45 * min), sessions: [],
  });
  // Routine heartbeat / github.observed events must NOT reset the moving clock.
  events.set('w-blocker', [
    { kind: 'block', at: at(-45 * min), stage: 'ready' },
    { kind: 'heartbeat', at: at(-2 * min), stage: 'ready' },
    { kind: 'github.observed', at: at(-1 * min), stage: 'ready' },
  ]);

  // 2. Item in review with a live reviewer inside the usual time (20m median -> 60m threshold; 25m elapsed -> NOT reported).
  const reviewOk = workFixture({
    id: 'w-rev-ok', key: 'GY-102', title: 'Fresh review', stage: 'review', ready: true,
    stageEnteredAt: at(-25 * min),
    sessions: [{ id: 'rev-1', kind: 'review', state: 'running', principal: 'reviewer-1', startedAt: at(-20 * min) } as never],
  });

  // 3. Item in review at four times the usual time (4 * 20m = 80m > 60m -> reported, owner reviewer).
  const reviewSlow = workFixture({
    id: 'w-rev-slow', key: 'GY-103', title: 'Slow review', stage: 'review', ready: true,
    stageEnteredAt: at(-85 * min),
    sessions: [{ id: 'rev-2', kind: 'review', state: 'running', principal: 'reviewer-2', startedAt: at(-80 * min) } as never],
  });

  // 4. Backed-off action past its retry time (retryAt in the past, no live session, > 30m -> reported, owner nobody).
  const backedOff = workFixture({
    id: 'w-backoff', key: 'GY-104', title: 'Backed-off retry', stage: 'test', ready: true,
    stageEnteredAt: at(-50 * min),
    actionQueue: {
      actions: [{
        id: 'act-1', kind: 'merge', work: 'w-backoff', key: 'GY-104', state: 'pending', claim: null, attempts: 2,
        retryAt: at(-10 * min), requestedAt: at(-50 * min), requestedBy: 'graphyard', binding: 'b', gate: null, refusal: null, reason: 'retry',
        inputs: {} as never, history: [{ at: at(-40 * min), event: 'failed', requester: 'graphyard', executor: 'loop', result: null, reason: 'transient' }],
      }],
      history: [],
    },
  });

  // 5. Item waiting on a human request (listed separately, never counted as system stall).
  const humanWait = workFixture({
    id: 'w-human', key: 'GY-105', title: 'Needs human choice', stage: 'ready', ready: true,
    stageEnteredAt: at(-6 * hr),
    humanRequest: { id: 'hr-1', kind: 'goals-and-priorities', reason: 'Pick one', needed: 'Choice', requestedBy: 'master', epoch: 1, at: at(-6 * hr) },
  });

  // 6. Ceiling check: build median 100m -> 3x = 300m -> capped at 4h (240m). At 250m with live builder, reported with owner 'a builder'.
  const buildCapped = workFixture({
    id: 'w-build-cap', key: 'GY-106', title: 'Long build over 4h cap', stage: 'build', ready: true,
    stageEnteredAt: at(-250 * min),
    sessions: [{ id: 'b-1', kind: 'implementation', state: 'running', principal: 'worker-1', startedAt: at(-250 * min) } as never],
  });

  // 7. Ready work queued behind busy builders: no blocker, lease or session. Its next step is a builder's,
  // judged by the usual ready time (floored at 30m): 20m queued is not reported, 40m is.
  const queuedFresh = workFixture({ id: 'w-queued-fresh', key: 'GY-107', title: 'Queued for a builder', stage: 'ready', ready: true, stageEnteredAt: at(-20 * min), sessions: [] });
  const queuedOld = workFixture({ id: 'w-queued-old', key: 'GY-108', title: 'Queued long for a builder', stage: 'ready', ready: true, stageEnteredAt: at(-40 * min), sessions: [] });
  // 8. Ready work waiting on an open dependency is not stalled itself: the dependency is.
  const waitsOnDep = workFixture({ id: 'w-dep', key: 'GY-109', title: 'Waits on GY-106', stage: 'ready', ready: true, stageEnteredAt: at(-3 * hr), sessions: [], dependencies: ['w-build-cap'] });

  // 9. A blocker waiting on a request a person decides is listed apart; one waiting on a scope request is the Lead's.
  const humanDecided = workFixture({ id: 'w-hd', key: 'GY-110', title: 'Blocker a person decides', stage: 'ready', ready: true, stageEnteredAt: at(-2 * hr), blocker: 'pick a goal', blockedAt: at(-2 * hr), sessions: [],
    agentRequests: [{ id: 'br-1', type: 'blocker', epoch: 1, requestedBy: 'worker-a', at: at(-2 * hr), reason: 'pick a goal', humanDecision: 'goals-and-priorities', decider: { kind: 'human', who: 'the owner', command: null }, releasedLease: true, state: 'open' }] as never });
  const scopeAsk = workFixture({ id: 'w-sr', key: 'GY-111', title: 'Blocker on a scope request', stage: 'ready', ready: true, stageEnteredAt: at(-35 * min), blocker: 'needs a file', blockedAt: at(-35 * min), sessions: [],
    agentRequests: [{ id: 'sr-1', type: 'scope-request', epoch: 1, requestedBy: 'worker-a', at: at(-35 * min), reason: 'Need extra file', decider: { kind: 'rule', who: 'master', command: null }, releasedLease: true, state: 'open' }] as never });

  const result = deriveNotMoving([...finished, staleBlocker, reviewOk, reviewSlow, backedOff, humanWait, buildCapped, queuedFresh, queuedOld, waitsOnDep, humanDecided, scopeAsk], now, events);

  // Waiting on a person is separate and never in notMoving.
  assert.deepEqual(result.waitingOnPerson.map(i => i.key), ['GY-105', 'GY-110']);
  assert.equal(result.waitingOnPerson[0]!.owner, 'a person');
  assert.equal(result.notMoving.some(i => i.key === 'GY-105'), false, 'human wait is never counted as system stall');

  // Review inside usual time is not reported.
  assert.equal(result.notMoving.some(i => i.key === 'GY-102'), false, 'live review inside usual time is not reported');

  // Oldest first: GY-106 (250m), GY-103 (80m), GY-104 (50m), GY-101 (45m), GY-108 (40m); never GY-107 or GY-109.
  assert.deepEqual(result.notMoving.map(i => i.key), ['GY-106', 'GY-103', 'GY-104', 'GY-101', 'GY-108', 'GY-111']);
  assert.equal(result.notMoving.find(i => i.key === 'GY-111')!.owner, 'the Lead', 'a scope request is the Lead\'s to decide, not nobody');
  assert.equal(result.notMoving.find(i => i.key === 'GY-108')!.owner, 'a builder', 'queued ready work waits on a builder, not nobody');
  assert.equal(result.notMoving.find(i => i.key === 'GY-101')!.owner, 'nobody');
  assert.equal(result.notMoving.find(i => i.key === 'GY-103')!.owner, 'a reviewer');
  assert.equal(result.notMoving.find(i => i.key === 'GY-104')!.owner, 'nobody');
  assert.equal(result.notMoving.find(i => i.key === 'GY-106')!.owner, 'a builder');
});

test('integration:not-moving-items-reach-status-wake-and-lead-page — oldest first, max 5 + rest count, 1h wake repeat, and empty shows nothing', async () => {
  const items: NotMovingItem[] = [1, 2, 3, 4, 5, 6, 7].map(i => ({
    key: `GY-${200 + i}`,
    title: `Stalled item ${i}`,
    stage: i % 2 === 0 ? 'review' : 'ready',
    ageMs: (100 - i * 5) * min,
    owner: i % 2 === 0 ? 'a reviewer' : 'nobody',
  }));

  // Formatting: max 5 + count of the rest, one plain line each.
  const lines = formatNotMovingLines(items);
  assert.equal(lines.length, 6, '5 items plus count of the rest');
  assert.match(lines[0]!, /^GY-201 Stalled item 1 .*1h 35m.*ready.*nobody/);
  assert.match(lines[5]!, /\+2 more/);
  assert.deepEqual(formatNotMovingLines([]), [], 'empty produces no lines (no stall none)');
  assert.deepEqual(notMovingLines([]), [], 'Lead feed helper produces no lines when empty');
  assert.equal(notMovingLines(items).length, 6, 'Lead feed helper caps at 5 plus rest');

  // Wire into masterStatusReport and runCycle.
  const directory = await temporaryDirectory('not-moving-integration');
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard',
    hostId: 'test-host', baseBranch: 'main', masterAgentName: 'master', workers: [],
    run: { masterHeartbeatMinutes: 240 },
  });
  const state = emptyDaemonState(config);
  let clock = now;
  let currentNotMoving = items;
  const wakes: string[] = [];
  const openWork = items.map(i => workFixture({ id: `id-${i.key}`, key: i.key, title: i.title, stage: i.stage as Work['stage'], ready: true, stageEnteredAt: at(-i.ageMs) }));

  const effects: DaemonEffects = {
    snapshot: async () => ({ work: openWork, now: new Date(clock).toISOString() }),
    flow: async () => ({ notMoving: currentNotMoving }),
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => ({}),
    persist: async () => {},
    masterSession: {
      wake: async (_target, text) => { wakes.push(text); },
      launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'a', session: 's' }),
    },
  };

  // Cycle 1: wakes with the 5 oldest items + count of rest.
  await runCycle(config, state, effects, () => clock);
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0]!.includes('GY-201'));
  assert.ok(wakes[0]!.includes('GY-205'));
  assert.ok(!wakes[0]!.includes('GY-206'), 'at most five items in wake message');
  assert.match(wakes[0]!, /\+2 more/);

  // 30 minutes later (ages increased, same stage/owner): must NOT repeat before 1 hour.
  clock += 30 * min;
  currentNotMoving = items.map(i => ({ ...i, ageMs: i.ageMs + 30 * min }));
  await runCycle(config, state, effects, () => clock);
  assert.equal(wakes.length, 1, 'wake repeats an item at most once an hour');

  // 30 more minutes (60m total): repeats now.
  clock += 30 * min;
  currentNotMoving = items.map(i => ({ ...i, ageMs: i.ageMs + 60 * min }));
  await runCycle(config, state, effects, () => clock);
  assert.equal(wakes.length, 2, 'wake repeats after an hour');

  // master status includes notMoving when present, omits it when empty.
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('not-moving-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'c'.repeat(40)}\n`;

  const reportWith = await masterStatusReport(root, config, async (path: string) => path === 'work-snapshot' ? { work: openWork, now: new Date(clock).toISOString() } : path === 'not-moving' ? { notMoving: currentNotMoving } : { messages: [] }, run);
  assert.ok(Array.isArray((reportWith as any).notMoving) && (reportWith as any).notMoving.length === 6);
  assert.match((reportWith as any).notMoving[0], /GY-201/);

  const reportEmpty = await masterStatusReport(root, config, async (path: string) => path === 'work-snapshot' ? { work: [], now: new Date(clock).toISOString() } : path === 'not-moving' ? { notMoving: [] } : { messages: [] }, run);
  assert.equal('notMoving' in reportEmpty, false, 'empty notMoving is omitted from master status');
  assert.equal(JSON.stringify(reportEmpty).toLowerCase().includes('stall none'), false);

  // Lead page renders nothing for not-moving when empty.
  const emptyMarkup = renderToStaticMarkup(createElement(MasterPage, { work: [], observedAt: clock, token: '', api: async () => ({}), setSelected: () => {}, action: async () => {}, busy: false }));
  assert.equal(emptyMarkup.includes('Not moving'), false, 'Lead page shows nothing for not-moving when none');
});
