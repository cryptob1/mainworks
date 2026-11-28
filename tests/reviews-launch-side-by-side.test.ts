import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { automaticReviewerConcurrency, sessionAgentName } from '../src/master/profiles.js';
import { loadMasterConfig } from '../src/master/config.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { fleet, requested } from './helpers/review-fleet.js';

// GY-3642: reviews launch side by side like producers do, bounded by the reviewer role's
// concurrency, so one slow launch never holds the others back.

async function runSideBySideTest(beforeReconcile?: () => Promise<void>) {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    assert.equal(automaticReviewerConcurrency, 4, 'the reviewer role runs four sessions at once');
    const items = [requested(1), requested(2), requested(3), requested(4)];
    const started: string[] = [], finished: string[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    let markThreeFinished!: () => void;
    const threeFinished = new Promise<void>(resolve => { markThreeFinished = resolve; });
    const base = host.effects(() => items, () => config);
    const effects = { ...base,
      reconcileReviews: async (...args: Parameters<typeof base.reconcileReviews>) => {
        if (beforeReconcile) await beforeReconcile();
        return base.reconcileReviews(...args);
      },
      launchReview: async (work: { key: string }, request: { id: string }, profile: { agentName: string }) => {
        started.push(work.key);
        // GY-501's launch takes its full bound (60 s in production); the test holds it until released.
        if (work.key === 'GY-501') { markFirstStarted(); await slow; }
        finished.push(work.key);
        if (finished.length === 3) markThreeFinished();
        return { agentName: sessionAgentName(profile, { id: request.id, requestId: request.id }), pane: `pane-${work.key}` };
      } } as Parameters<typeof runDispatchTick>[2];
    const tick = runDispatchTick(config, emptyDispatchCursor(config), effects, Date.now);
    try {
      // Wait for pre-launch tick work (including cold Postgres init in reconcileReviews) to reach
      // the first launch before waiting for the other three to finish alongside it.
      await Promise.race([firstStarted, tick]);
      const abort = new AbortController();
      try {
        await Promise.race([threeFinished, tick, delay(5_000, undefined, { signal: abort.signal }).catch(() => {})]);
      } finally { abort.abort(); }
      assert.deepEqual([...started].sort(), ['GY-501', 'GY-502', 'GY-503', 'GY-504'], `all four launches start within the same tick while the first is slow (started: ${started.join(', ')})`);
      assert.deepEqual([...finished].sort(), ['GY-502', 'GY-503', 'GY-504'], 'the slow launch leaves the other three started');
    } finally { releaseSlow(); }
    const result = await tick;
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.launched.filter(entry => entry.kind === 'review').map(entry => entry.work).sort(), ['GY-501', 'GY-502', 'GY-503', 'GY-504']);
  } finally { await host.cleanup(); }
}

test('unit:reviews-launch-side-by-side — four heads owing a review start their four launches in one tick, and one slow launch leaves the other three started', () => runSideBySideTest());

// GY-4079: on the base tip, the 5 s poll loop started before reconcileReviews (which lazily
// initializes the Postgres loop-state fixture) finished, so a >5 s pre-launch step expired the
// wait before any launchReview began.
test('unit:reviews-launch-side-by-side-pinned — four heads still launch side by side when reconcileReviews takes longer than 5 s before launches start', () => runSideBySideTest(() => delay(5_200)));

test('unit:reviews-launch-side-by-side — launches beyond the reviewer role\'s concurrency wait for a running launch to finish', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 2 }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const items = [requested(1), requested(2), requested(3)];
    let running = 0, peak = 0, started = 0;
    let releaseFirstTwo!: () => void;
    const firstTwoGate = new Promise<void>(resolve => { releaseFirstTwo = resolve; });
    let markTwoRunning!: () => void;
    const twoRunning = new Promise<void>(resolve => { markTwoRunning = resolve; });
    const effects = { ...host.effects(() => items, () => config),
      launchReview: async (_work: unknown, request: { id: string }, profile: { agentName: string }) => {
        const order = ++started;
        peak = Math.max(peak, ++running);
        if (running === 2) markTwoRunning();
        if (order <= 2) await firstTwoGate;
        running--;
        return { agentName: sessionAgentName(profile, { id: request.id, requestId: request.id }), pane: null };
      } } as Parameters<typeof runDispatchTick>[2];
    const tick = runDispatchTick(config, emptyDispatchCursor(config), effects, Date.now);
    try {
      await Promise.race([twoRunning, tick]);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(running, 2, 'two launches hold the profile\'s slots while the third waits');
      assert.equal(started, 2, 'the third launch does not start while both slots are occupied');
    } finally { releaseFirstTwo(); }
    const result = await tick;
    assert.equal(peak, 2, 'no more launches run at once than the profile\'s concurrency');
    assert.equal(result.launched.filter(entry => entry.kind === 'review').length, 3);
  } finally { await host.cleanup(); }
});
