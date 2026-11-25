import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapGate, gateRecordPath, gateSummary, runDiagnostics, writeGateRecord } from '../src/batch-gate.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { measureOnboarding } from '../src/onboarding-scratch.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const commit = 'a'.repeat(40);

test('integration:onboarding-time-real — records connect through the first pushed merge in seconds, including a known delay', async () => {
  const store = await withDatabase('onboarding_real_delay');
  await store.init();
  const scratch = await temporaryDirectory('onboarding-real-delay');
  const start = Date.parse('2026-11-24T00:00:00Z'), delaySeconds = 123.45;
  let reads = 0;
  try {
    const run = await measureOnboarding(store, { scratch, commit, now: () => start + (reads++ === 0 ? 0 : delaySeconds * 1000) });
    assert.equal(run.result, 'passed', JSON.stringify(run));
    const seconds = (run as unknown as { seconds: number }).seconds;
    assert.ok(seconds >= delaySeconds, `elapsed seconds ${seconds} must include ${delaySeconds}`);
    assert.equal(seconds, delaySeconds, 'records seconds without rounding to minutes');
    const [work] = await store.list();
    const pushed = execFileSync('git', ['--git-dir', join(scratch, 'origin.git'), 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    assert.equal(pushed, work!.delivery!.mergeSha, 'the first change reached the scratch remote');
    const record = bootstrapGate('fixture/onboarding', commit);
    record.onboarding = run;
    assert.equal(gateSummary(record)!.onboarding!.minutes, 2.1);
  } finally { await store.close(); }
});

test('e2e:onboarding-time-real — a running scratch install reports a positive onboarding time in master status', async () => {
  const store = await withDatabase('onboarding_real_e2e');
  await store.init();
  const scratch = await temporaryDirectory('onboarding-real-e2e');
  try {
    const record = bootstrapGate('fixture/onboarding', commit);
    await runDiagnostics({ now: Date.now, file: async () => ({ item: null }), diagnose: async () => ({ failed: [], catalogMs: 1,
      onboarding: await measureOnboarding(store, { scratch, commit }) }) }, record);
    assert.equal(record.onboarding!.result, 'passed', JSON.stringify(record.onboarding));
    assert.ok((record.onboarding as unknown as { seconds: number }).seconds > 0);
    const root = join(scratch, 'fixture');
    await writeGateRecord(gateRecordPath(root), record);
    const config = { url: 'http://127.0.0.1:5', repository: 'fixture/onboarding', credentialFile: join(scratch, 'coordinator.token'), hostId: 'test-host', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
    const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), (command, args) => command === 'git' ? execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : '') as unknown as { batchGate: { onboarding: { minutes: number } } };
    assert.ok(report.batchGate.onboarding.minutes > 0, JSON.stringify(report.batchGate.onboarding));
    assert.equal(report.batchGate.onboarding.minutes, Math.ceil((record.onboarding as unknown as { seconds: number }).seconds / 6) / 10);
  } finally { await store.close(); }
});
