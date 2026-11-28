import { launchLegacyReview as launchReview } from './helpers/pending-review.js';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { loadMasterConfig } from '../src/master/config.js';
import { automaticReviewerConcurrency } from '../src/master/profiles.js';
import { emptyDispatchCursor, hostCausesClearPath } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import type { DispatchEffects } from '../src/dispatch/effects.js';
import { hostCauseAttention, reviewLaunchAttention } from '../src/cli/master-status.js';
import { fleet, requested } from './helpers/review-fleet.js';
import { registryFixture } from './helpers/registry-fixture.js';

// GY-4121: a reviewer runtime missing from the host failed every review at once, retried in
// silence for hours. A host cause now reads next: operator with its one-line fix, alerts once,
// pauses its retries and shows once in master status with the items it blocks.

test('integration:host-cause-escalates-to-operator — three reviews failing on one missing tool raise one signal, next: operator, no retries and a count of 3; clearing it resumes the retries', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const registry = registryFixture(hostname(), ['claude'], ['reviewer'], automaticReviewerConcurrency);
    const items = [requested(1), requested(2), requested(3)], alerts: string[] = [];
    let missing = true, attempts = 0;
    const effects = (): DispatchEffects => ({ ...host.effects(() => items, () => config), alert: async text => { alerts.push(text); },
      launchReview: async (work, request, profile, herdr, observedAt) => {
        attempts++;
        if (missing) throw new Error('spawn gy4121-reviewer-runtime ENOENT');
        return launchReview(host.root, work, profile.name, herdr, observedAt, { run: host.run, registerLaunch: host.registerLaunch, requestId: request.id, probe: registry.probe });
      } });
    const cursor = emptyDispatchCursor(config), later = (minutes: number) => () => Date.now() + minutes * 60_000;

    const first = await runDispatchTick(config, cursor, effects(), Date.now);
    assert.equal(first.refused.length, 3, 'all three stand-in reviews fail');
    assert.deepEqual(Object.keys(cursor.hostCauses), ['missing tool gy4121-reviewer-runtime'], 'one cause');
    assert.equal(alerts.length, 1, 'one signal for the cause');
    assert.match(alerts[0]!, /missing tool gy4121-reviewer-runtime.*Fix: Install gy4121-reviewer-runtime/);

    // Past every retry delay nothing relaunches: each item reads next: operator with the fix.
    const second = await runDispatchTick(config, cursor, effects(), later(30));
    assert.equal(attempts, 3, 'no retries while the cause stands');
    assert.deepEqual(second.waiting.filter(entry => entry.kind === 'review').map(entry => entry.work).sort(), ['GY-501', 'GY-502', 'GY-503']);
    for (const entry of second.waiting) assert.match(entry.reason, /^next: operator — Install gy4121-reviewer-runtime on \S+ so the loop's PATH finds it; retries pause/);
    assert.equal(alerts.length, 1, 'still one signal');

    // Master status: the cause once with its count; no per-item review line repeats it.
    const lines = hostCauseAttention(cursor);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.text, /^Missing tool gy4121-reviewer-runtime blocks 3 items \(GY-501, GY-502, GY-503\)/);
    assert.match(lines[0]!.next, /^Install gy4121-reviewer-runtime .*master host-causes clear/);
    assert.deepEqual(reviewLaunchAttention(items, cursor, Date.now()), []);

    // The operator fixes the host and clears the cause: the retries resume and launch.
    missing = false;
    await writeFile(hostCausesClearPath(config), `${new Date().toISOString()}\n`);
    const third = await runDispatchTick(config, cursor, effects(), later(31));
    assert.deepEqual(cursor.hostCauses, {}, 'the cause is lifted');
    assert.equal(attempts, 6, 'each review is retried');
    assert.deepEqual(third.launched.map(entry => entry.work).sort(), ['GY-501', 'GY-502', 'GY-503']);
    assert.deepEqual(hostCauseAttention(cursor), []);
  } finally { await host.cleanup(); }
});
