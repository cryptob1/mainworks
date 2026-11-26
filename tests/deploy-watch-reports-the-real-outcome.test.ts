// GY-3904 (re-land GY-3902): the deploy record and status report what happened: a failed prune rolls nothing back,
// a kept tip keeps its failed step and reason, and a failed rollback reads as a failure, never unconfigured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlPlaneRecordPath, controlPlaneUpdateAttention, deployOnce, deployRecordPath, readControlPlaneRecord, readDeployRecord, servingReport, type DeployWatchPorts } from '../src/deploy-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40), repo = 'owner/app';

async function pass(throwAt: 'prune' | 'restart' | 'health' | 'rollback') {
  const root = await temporaryDirectory('deploy-real-outcome'), file = deployRecordPath(root);
  const logs: string[] = [];
  let database = 1;
  const migrates = throwAt === 'restart' || throwAt === 'health';
  const ports: DeployWatchPorts = {
    fetch: async () => b, head: async () => a,
    build: async commit => { if (throwAt === 'rollback' && commit === a) throw new Error('image for a is gone'); },
    restart: async commit => { if (migrates && commit === b) database = 2; if (throwAt === 'restart' && commit === b) throw new Error('compose up timed out'); },
    health: async commit => { if ((throwAt === 'health' || throwAt === 'restart' || throwAt === 'rollback') && commit === b) throw new Error('/healthz unhealthy'); },
    checkout: async () => {}, pin: async () => {},
    prune: async () => { if (throwAt === 'prune') throw new Error('docker rmi refused'); },
    schema: async commit => commit === b && migrates ? 2 : 1, database: async () => database,
  };
  const outcome = await deployOnce(file, ports, line => logs.push(line), repo);
  const control = readControlPlaneRecord(controlPlaneRecordPath(root));
  return { outcome, logs, record: readDeployRecord(file)!, attention: controlPlaneUpdateAttention(control), report: await servingReport(root, repo, 'main') };
}

test('unit:deploy-watch-reports-the-real-outcome — prune, restart after migration, health after migration and rollback failures are recorded and reported as they happened', async () => {
  const prune = await pass('prune');
  assert.equal(prune.outcome, 'deployed');
  assert.deepEqual([prune.record.tip, prune.record.failed, prune.record.restore ?? null], [b, null, null], 'the new commit serves; nothing rolled back');
  assert.equal(prune.logs.filter(line => line.includes('docker rmi refused')).length, 1, 'the prune error is logged once');
  assert.deepEqual([prune.report.unconfigured, prune.report.commit, prune.report.failedDeploy, prune.attention.length], [false, b, null, 0]);

  for (const step of ['restart', 'health'] as const) {
    const kept = await pass(step);
    assert.equal(kept.outcome, 'kept', step);
    assert.equal(kept.record.tip, b);
    assert.match(kept.record.reason ?? '', new RegExp(`^${step} failed: .*kept because`), 'the record keeps the failed step and reason');
    assert.equal(kept.attention.length, 1, `${step}: one attention line`);
    assert.match(kept.attention[0]!.text, new RegExp(`failed at ${step}.*${step} failed: (compose up timed out|/healthz unhealthy)`));
    assert.equal(kept.report.failedDeploy, null, 'shown once, as the attention line');
  }

  const rollback = await pass('rollback');
  assert.equal(rollback.outcome, 'restoring');
  assert.deepEqual([rollback.record.tip, rollback.record.failed, rollback.record.restore], [null, b, a]);
  assert.equal(rollback.report.unconfigured, false, 'a failed rollback is never unconfigured');
  assert.equal(rollback.report.failedDeploy?.tip, b, 'status says the deploy failed');
  assert.equal(rollback.report.failedDeploy?.restoring, a, 'and that a restore is in progress');
  assert.match(rollback.report.failedDeploy?.reason ?? '', /the rollback to a{12} failed \(attempt 1 of 5\)/);
});
