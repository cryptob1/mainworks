// GY-3746: a running deploy watch for an install that follows Mainworks's verified builds sees a newer
// verified build while a review session runs, and restarts nothing until the review ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { controlPlaneRecordPath, controlPlaneSummary, deployRecordPath, readControlPlaneRecord, readDeployRecord, watchMain, writeControlPlaneRecord, type DeployWatchPorts } from '../src/deploy-watch.js';
import { installInFlight } from '../src/cli/upgrade.js';
import { loopStateContext, type LoopStateKind } from '../src/loop-state.js';
import { mainworksRepository } from '../src/scenarios.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const settle = (ms: number) => new Promise(done => setTimeout(done, ms));

test('e2e:consumer-update-waits-for-quiet — a newer verified build waits while a review runs and is served once the review ends', { timeout: 60_000 }, async () => {
  const root = await temporaryDirectory('consumer-update-waits'), slots = await temporaryDirectory('consumer-update-slots');
  const file = deployRecordPath(root);
  // The install serves a, last updated two hours ago.
  await writeControlPlaneRecord(controlPlaneRecordPath(root), { commit: a, updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), checkedAt: null, verified: a, verifiedSeenAt: null, failedStep: null, failedReason: null, failedAt: null });

  // The loop's review ledger, with one stub review session in flight.
  const ledger: Record<LoopStateKind, Record<string, unknown>[]> = { reviews: [], producers: [], dispatch: [] };
  const review = { id: randomUUID(), key: 'GY-1', pr: 1, sha: a, baseSha: a, policyRevision: 1, profile: 'reviewer', agentName: 'reviewer-1', pane: null, sessionDirectory: root,
    requestedAt: new Date().toISOString(), tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), state: 'pending' };
  ledger.reviews.push(review);

  let upstream = a, running = a;
  const restarts: string[] = [];
  const ports: DeployWatchPorts = {
    fetch: async () => a, head: async () => a, verifiedUpstream: async () => upstream,
    busy: () => installInFlight(root, 'owner/consumer', slots), hotfix: async () => false,
    build: async () => {}, restart: async commit => { restarts.push(commit); running = commit; },
    health: async commit => { if (running !== commit) throw new Error(`serves ${running.slice(0, 12)}`); },
    checkout: async () => {}, pin: async () => {}, prune: async () => {}, schema: async () => 1, database: async () => 1,
  };
  const controller = new AbortController();
  await loopStateContext.run(() => ({ read: async kind => ledger[kind].map(record => ({ ...record })), write: async () => {} }), async () => {
    const watch = watchMain(file, ports, { intervalMs: 20, signal: controller.signal, log: () => {}, repository: mainworksRepository });
    try {
      // Publish a newer verified build while the review runs: several passes restart nothing.
      upstream = b;
      for (const start = Date.now(); !readControlPlaneRecord(controlPlaneRecordPath(root))?.waiting; await settle(20)) {
        if (Date.now() - start > 10_000) assert.fail('the watch never recorded the waiting build');
      }
      await settle(300);
      assert.deepEqual(restarts, [], 'no restart while the review runs');
      assert.match(controlPlaneSummary(readControlPlaneRecord(controlPlaneRecordPath(root)), Date.now())?.waiting ?? '', new RegExp(`^update to ${b.slice(0, 12)} waits: a review is running, last update 1\\d\\d minutes ago$`));

      // The review ends: the next quiet pass serves the newer build.
      review.state = 'completed';
      for (const start = Date.now(); readDeployRecord(file)?.tip !== b; await settle(20)) {
        if (Date.now() - start > 10_000) assert.fail(`the watch never served ${b.slice(0, 12)} after the review ended`);
      }
      assert.deepEqual(restarts, [b]);
      assert.equal(readControlPlaneRecord(controlPlaneRecordPath(root))?.waiting, null);
    } finally {
      controller.abort(); await watch;
    }
  });
});
