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

test('unit:reviews-launch-side-by-side — four heads owing a review start their four launches in one tick, and one slow launch leaves the other three started', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    assert.equal(automaticReviewerConcurrency, 4, 'the reviewer role runs four sessions at once');
    const items = [requested(1), requested(2), requested(3), requested(4)];
    const started: string[] = [], finished: string[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const effects = { ...host.effects(() => items, () => config),
      launchReview: async (work: { key: string }, request: { id: string }, profile: { agentName: string }) => {
        started.push(work.key);
        // GY-501's launch takes its full bound (60 s in production); the test holds it until released.
        if (work.key === 'GY-501') await slow;
        finished.push(work.key);
        return { agentName: sessionAgentName(profile, { id: request.id, requestId: request.id }), pane: `pane-${work.key}` };
      } } as Parameters<typeof runDispatchTick>[2];
    const tick = runDispatchTick(config, emptyDispatchCursor(config), effects, Date.now);
    try {
      // Wait until the first launch has started and the others have had their chance (or 5 s pass).
      for (const until = Date.now() + 5_000; Date.now() < until && finished.length < 3;) await delay(20);
      await delay(100);
      assert.deepEqual([...started].sort(), ['GY-501', 'GY-502', 'GY-503', 'GY-504'], `all four launches start within the same tick while the first is slow (started: ${started.join(', ')})`);
      assert.deepEqual([...finished].sort(), ['GY-502', 'GY-503', 'GY-504'], 'the slow launch leaves the other three started');
    } finally { releaseSlow(); }
    const result = await tick;
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.launched.filter(entry => entry.kind === 'review').map(entry => entry.work).sort(), ['GY-501', 'GY-502', 'GY-503', 'GY-504']);
  } finally { await host.cleanup(); }
});

test('unit:reviews-launch-side-by-side — launches beyond the reviewer role\'s concurrency wait for a running launch to finish', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 2 }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const items = [requested(1), requested(2), requested(3)];
    let running = 0, peak = 0;
    const effects = { ...host.effects(() => items, () => config),
      launchReview: async (_work: unknown, request: { id: string }, profile: { agentName: string }) => {
        peak = Math.max(peak, ++running);
        await delay(50);
        running--;
        return { agentName: sessionAgentName(profile, { id: request.id, requestId: request.id }), pane: null };
      } } as Parameters<typeof runDispatchTick>[2];
    const result = await runDispatchTick(config, emptyDispatchCursor(config), effects, Date.now);
    assert.equal(peak, 2, 'no more launches run at once than the profile\'s concurrency');
    assert.equal(result.launched.filter(entry => entry.kind === 'review').length, 3);
  } finally { await host.cleanup(); }
});
