import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapGate, gateRecordPath, gateSummary, readGateRecord, runGate, writeGateRecord, type GatePorts } from '../src/batch-gate.js';
import { deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import type { ServeLanding } from '../src/merge-writer/serve-revert.js';
import type { Work } from '../src/model.js';
import { commandCase, cycleUntil, deployPass, git, pipelineWorld, repository, worldLoop } from './helpers/pipeline-world.js';

// GY-3629: when a gate check passes on the verified commit and still fails after the first
// bisected culprit is reverted, the gate bisects the reverted tip again and reverts the next
// culprit; it files the check flaky and exempts it only if no prefix of the reverted tip fails,
// and never ends that run with outcome retry.

const item = (key: string, proofs: string[]): Work => ({ id: `work-${key}`, key, title: `${key} change`, description: `${key} change`, type: 'feature', priority: 2,
  criteria: [{ id: 'AC-1', text: `${key} works`, proofs }], mergeLedger: null } as unknown as Work);
const sha = (n: number) => `${n}`.repeat(40).slice(0, 40);
const landing = (n: number): ServeLanding => ({ sha: sha(n), before: sha(n - 1), subject: `Merge GY-${n}`, item: item(`GY-${n}`, [`e2e:case-${n}`]) });
const baseStillFailsText = 'the base tip fails the same checks, so the revert proves nothing yet';

/** Pure gate ports: `fails(commit, check, call)` decides each check's result, `revert` answers the revert port's verdict, and `without` maps a prefix without prior culprits. */
function gatePorts(
  landings: ServeLanding[],
  fails: (commit: string, check: string, call: number) => boolean,
  revert: (culpritKey: string, priorKeys: string[]) => { revertSha: string } | { held: string } | { retry: string; revertSha?: string },
  without?: (commit: string, priorKeys: string[]) => string | null,
) {
  let clock = 0, calls = 0;
  const runs: { commit: string; checks: string[] }[] = [], filed: string[] = [], reverted: string[] = [];
  let tip = landings.at(-1)!.sha;
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
    ...(without ? { without: async (commit: string, prior: readonly ServeLanding[]) => without(commit, prior.map(entry => entry.item!.key)) } : {}),
    revert: async (culprit, _gated, _check, prior = []) => {
      const priorKeys = prior.map(entry => entry.item.key);
      reverted.push([...priorKeys, culprit.item.key].join('+'));
      const result = revert(culprit.item.key, priorKeys);
      if ('revertSha' in result && !('retry' in result)) tip = result.revertSha;
      return result;
    },
    file: async input => { filed.push(input.key); return { item: `GY-${100 + filed.length}` }; },
  };
  return { ports, runs, filed, reverted, setTip: (next: string) => { tip = next; } };
}

test('integration:gate-retry-files-flaky — a batch with two culprits for one check bisects the reverted tip and reverts both to reach verified; a flaky check whose reverted tip has no failing prefix is filed flaky once (reusing an open filing) and exempted; any other retry still retries', async () => {
  const verified = sha(1), batch = [landing(2), landing(3), landing(4)], tip = sha(4);
  const fresh = () => bootstrapGate(repository, verified);

  // 1. Two culprits (GY-2 and GY-4; GY-3 is innocent) break test:tests/a.test.ts, which passes on verified.
  // Reverting GY-2 alone leaves GY-4 failing the test, so the revert trial answers baseStillFails with R1 = sha(8).
  // The gate bisects R1 over [GY-3, GY-4], skips innocent GY-3 (whose prefix without GY-2 is sha(7), passing),
  // finds GY-4 on R1, reverts both together onto R2 = sha(9), and the recut on R2 settles verified.
  {
    const r1 = sha(8), r2 = sha(9), gy3WithoutGy2 = sha(7);
    const { ports, filed, reverted } = gatePorts(
      batch,
      (commit, check) => check === 'test:tests/a.test.ts' && ![verified, gy3WithoutGy2, r2].includes(commit),
      (culprit, prior) => culprit === 'GY-2' && !prior.length
        ? { retry: baseStillFailsText, revertSha: r1 }
        : culprit === 'GY-4' && prior.join(',') === 'GY-2'
          ? { revertSha: r2 }
          : { held: `unexpected revert ${prior.join(',')}+${culprit}` },
      (commit, prior) => commit === sha(3) && prior.join(',') === 'GY-2' ? gy3WithoutGy2 : commit,
    );
    const record = fresh();
    const first = await runGate(ports, record);
    assert.equal(first.outcome, 'reverted', JSON.stringify(first));
    assert.deepEqual(reverted, ['GY-2', 'GY-2+GY-4'], 'first tried GY-2, then stacked GY-4 onto it');
    assert.deepEqual(filed, [], 'a two-culprit failure is not filed as flaky');
    const second = await runGate(ports, record);
    assert.equal(second.outcome, 'verified', JSON.stringify(second));
    assert.equal(record.verified, r2);
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [['GY-2', true], ['GY-4', true], ['GY-3', false]]);
  }

  // 2. Two culprits (GY-2 and GY-4; GY-3 is innocent) break e2e:smoke, which passes on verified.
  // Reverting GY-2 pushes R1 = sha(8) directly; on the recut, e2e:smoke still fails on R1, passes on verified,
  // so instead of holding, the gate bisects R1, skips innocent GY-3 (sha(7) passes), reverts GY-4 -> R2 = sha(9),
  // and the recut on R2 settles verified.
  {
    const r1 = sha(8), r2 = sha(9), gy3WithoutGy2 = sha(7);
    const { ports, filed, reverted } = gatePorts(
      batch,
      (commit, check) => check === 'e2e:smoke' && ![verified, gy3WithoutGy2, r2].includes(commit),
      culprit => culprit === 'GY-2' ? { revertSha: r1 } : culprit === 'GY-4' ? { revertSha: r2 } : { held: `unexpected ${culprit}` },
      (commit, prior) => commit === sha(3) && prior.join(',') === 'GY-2' ? gy3WithoutGy2 : commit,
    );
    const record = fresh();
    const first = await runGate(ports, record);
    assert.equal(first.outcome, 'reverted', JSON.stringify(first));
    const second = await runGate(ports, record);
    assert.equal(second.outcome, 'reverted', JSON.stringify(second));
    const third = await runGate(ports, record);
    assert.equal(third.outcome, 'verified', JSON.stringify(third));
    assert.deepEqual(reverted, ['GY-2', 'GY-4']);
    assert.deepEqual(filed, []);
    assert.equal(record.verified, r2);
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [['GY-2', true], ['GY-4', true], ['GY-3', false]]);
  }

  // 3. Flaky check: passes on verified, fails on tip + rerun and on GY-2, GY-2's revert returns baseStillFails
  // with R1 = sha(8), and NO prefix of R1 fails (both GY-3 without GY-2 and R1 pass). The check is filed flaky
  // once, exempted, and the batch verifies on its other checks — never outcome retry.
  {
    const r1 = sha(8), gy3WithoutGy2 = sha(7);
    const { ports, filed, reverted } = gatePorts(
      batch,
      (commit, check) => check === 'e2e:case-3' && (commit === sha(2) || commit === tip),
      culprit => culprit === 'GY-2' ? { retry: baseStillFailsText, revertSha: r1 } : { held: `unexpected ${culprit}` },
      (commit, prior) => commit === sha(3) && prior.join(',') === 'GY-2' ? gy3WithoutGy2 : commit,
    );
    const record = fresh();
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'verified', JSON.stringify(outcome));
    assert.deepEqual(filed, ['flake:e2e:case-3'], 'the check is filed flaky once');
    assert.deepEqual(reverted, ['GY-2']);
    assert.equal(record.verified, tip);
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [['GY-2', false], ['GY-3', false], ['GY-4', false]]);
    assert.deepEqual(outcome.outcome === 'verified' && outcome.knownFlaky, [{ check: 'e2e:case-3', item: 'GY-101' }]);
    assert.equal(record.lastOutcome?.reason, 'kept the batch: e2e:case-3 failed and has the open flaky item GY-101');
    assert.deepEqual(record.flaky?.['GY-101']?.map(failure => [failure.check, failure.tip]), [['e2e:case-3', tip]]);
    assert.deepEqual(gateSummary(record)!.knownFlaky.map(entry => [entry.item, entry.check, entry.failures]), [['GY-101', 'e2e:case-3', 1]]);
  }

  // 4. An existing flaky filing on the record is reused, never re-filed, and the batch still verifies.
  {
    const r1 = sha(8);
    const { ports, filed } = gatePorts(
      [landing(2), landing(3)],
      (commit, check) => check === 'e2e:case-3' && (commit === sha(2) || commit === sha(3)),
      () => ({ retry: baseStillFailsText, revertSha: r1 }),
    );
    const record = fresh();
    record.filed!['flake:e2e:case-3'] = { item: 'GY-77', at: '2026-11-21T00:00:00.000Z' };
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'verified', JSON.stringify(outcome));
    assert.deepEqual(filed, [], 'the open filing is reused, not filed again');
    assert.deepEqual(outcome.outcome === 'verified' && outcome.knownFlaky, [{ check: 'e2e:case-3', item: 'GY-77' }]);
  }

  // 5. Any other retry — a push the moving main rejected — still retries and verifies nothing.
  {
    const { ports } = gatePorts(
      [landing(2), landing(3)],
      (commit, check) => check === 'e2e:case-3' && commit !== verified,
      () => ({ retry: `the leased push of the revert of GY-2's merge was rejected; the base moved` }),
    );
    const record = fresh();
    const outcome = await runGate(ports, record);
    assert.deepEqual(outcome, { outcome: 'retry', tip: sha(3), reason: `the leased push of the revert of GY-2's merge was rejected; the base moved` });
    assert.equal(record.verified, verified);
    assert.equal(record.lastOutcome?.outcome, 'retry');
  }
});

test('e2e:gate-retry-files-flaky — a gate with two culprits for one check reverts both, keeps innocent work, reaches verified and serves it', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('gate-retry-files-flaky', {
    'e2e/cases/smoke.json': commandCase('smoke', `node --eval "process.exit(require('fs').existsSync('broken-a') || require('fs').existsSync('broken-b') ? 1 : 0)"`),
  });
  const gateFile = gateRecordPath(world.checkout), gate = () => readGateRecord(gateFile)!;
  try {
    await writeGateRecord(gateFile, { ...bootstrapGate(repository, world.base), diagnosticsAt: new Date().toISOString() });
    // Land three items in one batch while gating is off: two independently break smoke, the middle one is innocent.
    const loop = worldLoop(world, { gate: false });
    const culpritA = await world.submit('First culprit breaking smoke', { 'broken-a': 'yes\n' });
    await cycleUntil(loop, `${culpritA.key} lands`, async () => (await world.work()).find(entry => entry.id === culpritA.id)?.stage === 'done');
    const innocent = await world.submit('Innocent change between culprits', { 'good.txt': 'ok\n' });
    await cycleUntil(loop, `${innocent.key} lands`, async () => (await world.work()).find(entry => entry.id === innocent.id)?.stage === 'done');
    const culpritB = await world.submit('Second culprit breaking smoke', { 'broken-b': 'yes\n' });
    await cycleUntil(loop, `${culpritB.key} lands`, async () => (await world.work()).find(entry => entry.id === culpritB.id)?.stage === 'done');

    // Now gate the batch: the gate reverts culpritA, sees smoke still fail (while passing on verified),
    // bisects the reverted tip, keeps innocent, reverts culpritB, and verifies the resulting tip.
    loop.gating(true);
    await cycleUntil(loop, 'the gate reverts both culprits and verifies main', () => gate().verified === world.main(), 180_000);
    const tip = world.main(), record = gate();
    assert.equal(record.lastOutcome?.outcome, 'verified');
    const reverts = git(world.origin, 'log', '--format=%s', `${world.base}..main`).split('\n').filter(subject => subject.startsWith('Revert'));
    assert.equal(reverts.length, 2, `expected two reverts on main, got: ${JSON.stringify(reverts)}`);
    assert.deepEqual(record.reverts?.map(entry => entry.item), [culpritA.key, culpritB.key], `expected both culprits reverted: ${JSON.stringify(record.reverts)}`);

    // The verified tree keeps the innocent change and removes both broken files.
    git(world.checkout, 'fetch', '-q', 'origin', 'main');
    git(world.checkout, 'checkout', '-q', '--detach', tip);
    assert.equal(existsSync(join(world.checkout, 'good.txt')), true, 'innocent change stays on main');
    assert.equal(existsSync(join(world.checkout, 'broken-a')), false, 'first culprit is removed');
    assert.equal(existsSync(join(world.checkout, 'broken-b')), false, 'second culprit is removed');

    const work = await world.work();
    assert.ok(work.some(entry => entry.title.startsWith(`Re-land ${culpritA.key}`)), `expected re-land for ${culpritA.key}`);
    assert.ok(work.some(entry => entry.title.startsWith(`Re-land ${culpritB.key}`)), `expected re-land for ${culpritB.key}`);
    assert.deepEqual(record.merges.map(merge => [merge.item, merge.reverted]), [[culpritA.key, true], [culpritB.key, true], [innocent.key, false]]);

    // The deploy watch serves the verified tip.
    assert.equal(await deployPass(world), 'deployed');
    assert.equal(readDeployRecord(deployRecordPath(world.checkout))?.tip, tip);
  } finally { await world.close(); }
});
