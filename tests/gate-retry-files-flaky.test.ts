import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, gateRecordPath, gateSummary, readGateRecord, runGate, writeGateRecord, type GatePorts } from '../src/batch-gate.js';
import { deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { runMergeTrial, type MergeTrialInput, type MergeTrialRun } from '../src/merge-writer/executor.js';
import type { ServeLanding } from '../src/merge-writer/serve-revert.js';
import { gateTrialKey } from '../src/merge-writer/trial-load.js';
import type { Work } from '../src/model.js';
import { cycleUntil, deployPass, git, pipelineWorld, repository, worldLoop } from './helpers/pipeline-world.js';

// GY-3629: a gate check that still fails after its culprit is reverted is filed flaky and exempted,
// so the gate settles instead of retrying the same failing tip forever. The revert port's retry
// reason is the literal serve-revert answers (`baseStillFails`): the wording is the contract the
// gate matches, so the test pins it in plain text rather than importing the constant.

const item = (key: string, proofs: string[]): Work => ({ id: `work-${key}`, key, title: `${key} change`, description: `${key} change`, type: 'feature', priority: 2,
  criteria: [{ id: 'AC-1', text: `${key} works`, proofs }], mergeLedger: null } as unknown as Work);
const sha = (n: number) => `${n}`.repeat(40).slice(0, 40);
const landing = (n: number): ServeLanding => ({ sha: sha(n), before: sha(n - 1), subject: `Merge GY-${n}`, item: item(`GY-${n}`, [`e2e:case-${n}`]) });

/** Pure gate ports: `fails(commit, check, call)` decides each check's result, and `revert` answers the revert port's verdict for the culprit it is handed. */
function gatePorts(landings: ServeLanding[], fails: (commit: string, check: string, call: number) => boolean, revert: (culpritKey: string) => { revertSha: string } | { held: string } | { retry: string }) {
  let clock = 0, calls = 0;
  const runs: { commit: string; checks: string[] }[] = [], filed: string[] = [], reverted: string[] = [];
  const tip = landings.at(-1)!.sha;
  const ports: GatePorts = {
    now: () => clock,
    fetch: async () => tip,
    landings: async () => landings,
    files: async () => ['src/a.ts'],
    catalog: async () => ['create-work-item', 'smoke', ...landings.flatMap(entry => entry.item!.criteria.flatMap(criterion => criterion.proofs.filter(proof => proof.startsWith('e2e:')).map(proof => proof.slice(4))))],
    core: async () => ['create-work-item', 'smoke'],
    run: async (commit, checks) => {
      runs.push({ commit, checks: [...checks] });
      const call = calls++;
      const expanded = checks.flatMap(check => check === 'affected' ? ['test:tests/a.test.ts'] : [check]);
      return expanded.filter(check => fails(commit, check, call));
    },
    revert: async culprit => { reverted.push(culprit.item.key); return revert(culprit.item.key); },
    file: async input => { filed.push(input.key); return { item: `GY-${100 + filed.length}` }; },
  };
  return { ports, runs, filed, reverted };
}

test('integration:gate-retry-files-flaky — a revert that proves nothing (the base tip still fails the same check) files the check flaky once, exempts it and verifies the batch on its other checks; an existing filing is reused, a check that passes without the culprit still reverts it, and any other retry still retries', async () => {
  const verified = sha(1), batch = [landing(2), landing(3)], tip = sha(3);
  const fresh = () => bootstrapGate(repository, verified);
  const failsEverywhereFromTheFirstLanding = (commit: string, check: string) => check === 'e2e:case-3' && commit !== sha(1);

  // The check fails on the tip and on every prefix, so the bisect names GY-2 — but the base tip
  // without GY-2 fails it too, so the revert proves nothing.
  {
    const { ports, filed, reverted } = gatePorts(batch, failsEverywhereFromTheFirstLanding, culprit =>
      culprit === 'GY-2' ? { retry: 'the base tip fails the same checks, so the revert proves nothing yet' } : { revertSha: `${'e'.repeat(39)}1` });
    const record = fresh();
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'verified', JSON.stringify(outcome));
    assert.deepEqual(filed, ['flake:e2e:case-3'], 'the check is filed flaky');
    assert.deepEqual(reverted, ['GY-2'], 'the culprit\'s revert was attempted once and pushed nothing');
    assert.equal(record.verified, tip, 'the batch verifies on its other checks');
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [['GY-2', false], ['GY-3', false]]);
    assert.deepEqual(outcome.outcome === 'verified' && outcome.knownFlaky, [{ check: 'e2e:case-3', item: 'GY-101' }]);
    assert.equal(record.lastOutcome?.reason, 'kept the batch: e2e:case-3 failed and has the open flaky item GY-101');
    assert.deepEqual(record.flaky?.['GY-101']?.map(failure => [failure.check, failure.tip]), [['e2e:case-3', tip]], 'the failure is recorded on the flaky item');
    assert.deepEqual(gateSummary(record)!.knownFlaky.map(entry => [entry.item, entry.check, entry.failures]), [['GY-101', 'e2e:case-3', 1]], 'master status names the flaky item');
  }
  // A filing this run already holds is reused, never re-filed, and the batch still verifies.
  {
    const { ports, filed } = gatePorts(batch, failsEverywhereFromTheFirstLanding, () => ({ retry: 'the base tip fails the same checks, so the revert proves nothing yet' }));
    const record = fresh();
    record.filed!['flake:e2e:case-3'] = { item: 'GY-77', at: '2026-11-21T00:00:00.000Z' };
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'verified');
    assert.deepEqual(filed, [], 'the open filing is reused, not filed again');
    assert.deepEqual(outcome.outcome === 'verified' && outcome.knownFlaky, [{ check: 'e2e:case-3', item: 'GY-77' }]);
  }
  // A check that passes without the culprit still reverts the culprit as today.
  {
    const { ports, reverted } = gatePorts(batch, (commit, check) => check === 'e2e:case-3' && commit === sha(3), () => ({ revertSha: `${'e'.repeat(39)}1` }));
    const record = fresh();
    const outcome = await runGate(ports, record);
    assert.deepEqual(outcome, { outcome: 'reverted', tip, check: 'e2e:case-3', culprit: 'GY-3', revertSha: `${'e'.repeat(39)}1` });
    assert.deepEqual(reverted, ['GY-3']);
    assert.equal(record.verified, verified, 'nothing is verified until the recut');
  }
  // Any other retry — a push the moving main rejected — still retries and verifies nothing.
  {
    const { ports } = gatePorts(batch, failsEverywhereFromTheFirstLanding, () => ({ retry: `the leased push of the revert of GY-2's merge was rejected; the base moved` }));
    const record = fresh();
    const outcome = await runGate(ports, record);
    assert.deepEqual(outcome, { outcome: 'retry', tip, reason: `the leased push of the revert of GY-2's merge was rejected; the base moved` });
    assert.equal(record.verified, verified);
    assert.equal(record.lastOutcome?.outcome, 'retry');
  }
});

test('e2e:gate-retry-files-flaky — a gate whose culprit\'s revert proves nothing (its trial fails a check the base tip fails too) files the check flaky, verifies the batch and serves it, and master status names the flaky item', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('gate-retry-files-flaky');
  const gateFile = gateRecordPath(world.checkout), gate = () => readGateRecord(gateFile)!;
  try {
    await writeGateRecord(gateFile, { ...bootstrapGate(repository, world.base), diagnosticsAt: new Date().toISOString() });
    // The revert's trial fails a repository check the base tip fails too (`failureIsBase`), exactly
    // as the loop's real trial reported it: the revert proves nothing, so the gate must settle on
    // the check itself instead of reverting a landing that fixes nothing.
    const trial = async (input: MergeTrialInput): Promise<MergeTrialRun> =>
      input.key === gateTrialKey || input.proofs.length || (input.e2eProofs ?? []).length
        ? runMergeTrial({ ...input, retries: 0, attribute: false })
        : { build: 'pass', tests: { passed: 0, failed: ['tests/repo-check.test.ts'], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
            base: { tip: world.main(), files: ['tests/repo-check.test.ts'], tests: ['repo check names cases'], cases: ['repo check names cases'] } } as unknown as MergeTrialRun;

    // The change fails the core smoke case on the tip; its own trial runs only its bound case, so it lands.
    const change = await world.submit('A change the smoke case fails on the tip', { broken: 'yes\n' });
    const loop = worldLoop(world, { gate: true, trial });
    await cycleUntil(loop, `${change.key} lands and the gate keeps it`, async () => (await world.work()).find(item => item.id === change.id)?.stage === 'done' && gate().verified === world.main());
    const tip = world.main(), record = gate();
    assert.deepEqual(git(world.origin, 'log', '--format=%s', 'main').split('\n').filter(subject => subject.startsWith('Revert')), [], 'nothing is reverted');
    assert.equal(record.lastOutcome?.outcome, 'verified');
    const flaky = (await world.work()).find(entry => entry.title === 'Flaky check on main: e2e:smoke');
    assert.ok(flaky, 'the gate filed the check as flaky');
    assert.equal(record.filed?.['flake:e2e:smoke']?.item, flaky.key);
    assert.equal(record.lastOutcome?.reason, `kept the batch: e2e:smoke failed and has the open flaky item ${flaky.key}`);
    assert.deepEqual(record.flaky?.[flaky.key]?.map(failure => [failure.check, failure.tip]), [['e2e:smoke', tip]], 'the failure is recorded on the flaky item');
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [[change.key, false]]);
    assert.deepEqual(gateSummary(record)!.knownFlaky.map(entry => [entry.item, entry.check]), [[flaky.key, 'e2e:smoke']], 'master status names the flaky item');

    // The deploy watch serves the verified tip, so main deploys again.
    assert.equal(await deployPass(world), 'deployed');
    assert.equal(readDeployRecord(deployRecordPath(world.checkout))?.tip, tip);
  } finally { await world.close(); }
});
