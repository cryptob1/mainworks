import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mergeWriterIdle } from '../src/daemon/cycle-merge-writer.js';
import { cycleUntil, git, pipelineWorld, rollout, worldLoop } from './helpers/pipeline-world.js';

// GY-3644: a reviewed head's trial passes while its acceptance gate still awaits a manual proof (the
// known-red repairs' manual:batch-gate-repaired on 11-22). main then moves and another head's trial
// takes the only trial slot. Once the proof is recorded the head lands on its kept passing trial within
// one cycle, without waiting for that slot — no rework, no resubmission.

test('integration:passed-trial-requeued-after-acceptance — a head whose trial passed while acceptance was refused is queued again once acceptance clears and lands with no rework', { timeout: 600_000 }, async () => {
  const world = await pipelineWorld('passed-trial-requeued-after-acceptance');
  try {
    await rollout(world);
    const proof = 'manual:batch-gate-repaired';
    const item = await world.submit('Known-red repair', { 'repair.txt': 'fixed\n' }, { proofs: [proof] });
    const head = item.candidate!.sha;
    const current = async () => (await world.work()).find(entry => entry.key === item.key)!;
    // One trial slot, as on 11-22 when every slot ran another head's trial.
    world.config.run.mergeWriter!.parallel = 1;
    const loop = worldLoop(world, { gate: false });
    await cycleUntil(loop, 'the trial passes ahead of acceptance', async () => {
      const ledger = (await current()).mergeLedger;
      return ledger?.state === 'refused' && ledger.trial?.head === head;
    }, 200_000);
    await mergeWriterIdle(loop.state);
    const held = await current();
    assert.ok(held.mergeLedger!.refusal!.reason.includes('acceptance gate awaits'), `the trial was kept for acceptance: ${held.mergeLedger!.refusal!.reason}`);
    assert.equal(world.main(), world.base, 'nothing lands while acceptance is refused');
    // Another change lands meanwhile, so the kept trial's base is no longer main's tip.
    const other = await world.submit('Other change', { 'other.txt': 'other\n' });
    await cycleUntil(loop, 'the other change lands', async () => (await world.work()).find(entry => entry.key === other.key)!.stage === 'done', 200_000);
    await mergeWriterIdle(loop.state);
    // A slow head takes the only trial slot.
    const slow = await world.submit('Slow change', { 'proof.cjs': `const { test } = require('node:test');\ntest('unit:declared', () => new Promise(resolve => setTimeout(resolve, 60_000)));\n` });
    await cycleUntil(loop, 'the slow head is trialling', () => !!loop.state.mergeWriter.inFlights?.some(entry => entry.key === slow.key), 60_000);

    // The proof is recorded: acceptance clears on the same head.
    await world.engine.execute({ id: 'producer', role: 'producer', proofs: [proof] }, 'evidence', item.id,
      { proof, sha: head, baseSha: item.candidate!.baseSha, policyRevision: held.policyRevision, result: 'pass', executed: 1, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 } }, randomUUID());
    assert.deepEqual((await current()).gates.find(gate => gate.name === 'acceptance')?.reasons, [], 'acceptance cleared');
    await loop.cycle();
    const done = await current();
    assert.ok(loop.state.mergeWriter.inFlights?.some(entry => entry.key === slow.key), 'the slow head still holds the only slot');
    assert.equal(done.stage, 'done', `the accepted head lands within one cycle on its kept trial, beside the busy slot: ${done.stage}, ledger ${JSON.stringify(done.mergeLedger?.refusal)}, queue ${JSON.stringify(loop.state.mergeWriter.queue)}`);
    git(world.checkout, 'fetch', '-q', 'origin', 'main');
    git(world.checkout, 'merge-base', '--is-ancestor', head, 'origin/main');
    assert.equal(done.mergeLedger?.state, 'reconciled');
    assert.equal(done.candidate!.sha, head, 'the same head landed: no resubmission');
    assert.ok(!done.reworkRequested, 'no rework was requested');
    await cycleUntil(loop, 'the slow head lands after it', async () => (await world.work()).find(entry => entry.key === slow.key)!.stage === 'done', 200_000);
  } finally { await world.close(); }
});
