// GY-3791: an install that follows Mainworks's verified builds updates at its own quiet moment; the
// followed project's merge trials, and the project-less file declarations they make, never hold it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlPlaneRecordPath, deployRecordPath, readDeployRecord, watchMain, writeControlPlaneRecord } from '../src/deploy-watch.js';
import { installInFlight } from '../src/cli/upgrade.js';
import { loopStateContext } from '../src/loop-state.js';
import { acquireVerificationSlot, heldSlots, testMergeLabel } from '../src/master/verification-slots.js';
import { declareTrialFiles } from '../src/merge-writer/trial.js';
import { mainworksRepository } from '../src/scenarios.js';
import { deployPorts } from './helpers/deploy-ports.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const quietLedgers = <T>(job: () => Promise<T>) => loopStateContext.run(() => ({ read: async () => [], write: async () => {} }), job);

test('integration:follower-update-not-held — only an install\'s own project\'s trial slot counts as its in-flight work', async () => {
  const root = await temporaryDirectory('follower-not-held'), slots = await temporaryDirectory('follower-not-held-slots');
  await quietLedgers(async () => {
    const trial = await acquireVerificationSlot({ directory: slots, label: testMergeLabel('GY-1'), project: mainworksRepository });
    try {
      assert.equal(await installInFlight(root, 'owner/consumer', slots), null, 'the followed project\'s trial does not hold the follower');
      assert.equal(await installInFlight(root, mainworksRepository, slots), 'a merge trial is running');
    } finally { trial.release(); }

    const undeclare = await declareTrialFiles(slots, 'GY-1', 4);
    try {
      assert.deepEqual(heldSlots(slots).map(({ owner }) => [owner?.label, owner?.project]), [['merge trial GY-1', undefined]]);
      assert.equal(await installInFlight(root, 'owner/consumer', slots), null, 'a slot with no project does not hold the follower');
      assert.equal(await installInFlight(root, mainworksRepository, slots), null, 'a slot with no project does not hold the source install');
    } finally { await undeclare(); }
  });
});

test('e2e:follower-update-not-held — a running deploy watch serves the newer verified build while the followed project\'s merge trial runs', { timeout: 60_000 }, async () => {
  const root = await temporaryDirectory('follower-watch'), slots = await temporaryDirectory('follower-watch-slots');
  const file = deployRecordPath(root);
  // The install serves a, last updated two hours ago.
  await writeControlPlaneRecord(controlPlaneRecordPath(root), { commit: a, updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), checkedAt: null, verified: a, verifiedSeenAt: null, failedStep: null, failedReason: null, failedAt: null });
  const trial = await acquireVerificationSlot({ directory: slots, label: testMergeLabel('GY-1'), project: mainworksRepository });
  const undeclare = await declareTrialFiles(slots, 'GY-1', 4);

  let running = a;
  const restarts: string[] = [];
  const ports = deployPorts(a, a, {
    verifiedUpstream: async () => b,
    busy: () => installInFlight(root, 'owner/consumer', slots), hotfix: async () => false,
    restart: async commit => { restarts.push(commit); running = commit; },
    health: async commit => { if (running !== commit) throw new Error(`serves ${running.slice(0, 12)}`); },
  });
  const controller = new AbortController();
  await quietLedgers(async () => {
    const watch = watchMain(file, ports, { intervalMs: 20, signal: controller.signal, log: () => {}, repository: mainworksRepository });
    try {
      for (const start = Date.now(); readDeployRecord(file)?.tip !== b; await new Promise(done => setTimeout(done, 20))) {
        if (Date.now() - start > 10_000) assert.fail(`the watch never served ${b.slice(0, 12)} while the followed project's trial ran`);
      }
      assert.deepEqual(restarts, [b]);
      assert.equal(heldSlots(slots).length, 2, 'the trial still holds its slots');
    } finally {
      controller.abort(); await watch; await undeclare(); trial.release();
    }
  });
});
