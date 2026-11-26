import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReceipt, comparison } from '../benchmarks/hard-math/receipt-schema.js';
import { pinnedPython } from '../benchmarks/hard-math/python.js';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { credential, startPlane } from '../benchmarks/hard-math/isolation.js';
import { runFixture } from './helpers/hard-math-fixture.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// A file of its own (GY-3206): the runner bounds each test file, so these fixture runs no longer
// share tests/hard-math-smoke.test.ts's bound with every other one.
// One verified environment per checkout: no wheel download or bytecode compile on each run (GY-3848).
const python=await pinnedPython(join(process.cwd(),'.graphyard','hard-math-python'));

test('integration:hard-math-smoke — real scratch Postgres/control plane and Git merge eight normal-risk components before native review dispatch/completion, reject an integration fault, repair and certify pushed CLI/API/UI', {timeout:295_000},async()=>{
  const receipt=await runFixture(python,'repair',{injectRepair:true,nativePostMerge:true});
  assert.equal(receipt.outcome,'PASS',`${receipt.reason}\n${JSON.stringify(receipt.failures,null,2)}`);assert.equal(receipt.kind,'controlled-fixture');
  assert.ok(receipt.overlaps.length);assert.equal(receipt.work.at(-1)?.repairs,1);
  assert.ok(receipt.failures.some(f=>f.component==='integration'));assert.equal(receipt.cost,null);assert.equal(receipt.costBudgetProven,false);
  assert.ok(receipt.sessions.some(s=>s.reason.includes('passed over')));
  for(const edit of [
    (r:any)=>{r.work[0].record.delivery=null;},
    (r:any)=>{delete r.work[0].record.pipeline;},(r:any)=>{r.work[0].record.workspaces=[];},(r:any)=>{r.artifact.sha='f'.repeat(40);},
    (r:any)=>{r.overlaps=[];},(r:any)=>{r.cost=0;},
  ]) {const bad=structuredClone(receipt);edit(bad);assert.throws(()=>validateReceipt(bad));}
  for(const edit of [
    (r:any)=>{r.reviewLaunch.verdict.sha=r.candidate.sha;},
    (r:any)=>{r.reviewLaunch.baseTip='f'.repeat(40);},
    (r:any)=>{r.reviewVerdicts.policyRevision++;},
    (r:any)=>{r.observation.reviews[0].sha='f'.repeat(40);},
    (r:any)=>{r.observation.reviews[0].state='CHANGES_REQUESTED';},
    (r:any)=>{r.observation.reviews[0].reviewer=r.candidate.author;},
    (r:any)=>{r.postMergeReview='owed';},
  ]) {
    const bad=structuredClone(receipt),distinct=bad.work.find(w=>w.candidate!==w.merge)!;
    edit(distinct.record);assert.throws(()=>validateReceipt(bad),/Missing independent approval/);
  }
  const unreviewed=structuredClone(receipt);(unreviewed.work[0].record as any).observation.reviews=[];
  assert.throws(()=>validateReceipt(unreviewed),/Missing independent approval/,'benchmark receipt rejects a missing review regardless of the production queue policy');
  const uncertified=structuredClone(receipt);(uncertified.work.at(-1)!.record as any).evidence=[];
  assert.throws(()=>validateReceipt(uncertified),/Missing independent final candidate certification/);
  assert.throws(()=>comparison(receipt,{...receipt,mode:'single'}),/actual team/);
});

// GY-3910: the in-process plane reconciled every 50 ms, competing with the run for the one CPU a trial lane has (45-49 s in release checks).
test('integration:hard-math-smoke — the in-process control plane reconciles no more often than the served plane (every 2 s)', async () => {
  const directory=await temporaryDirectory('hard-math-cadence');
  const original=Engine.prototype.reconcile;let ticks=0;
  Engine.prototype.reconcile=function(this:Engine,...args:Parameters<Engine['reconcile']>){ticks++;return original.apply(this,args);};
  const plane=await startPlane(directory,directory,[credential('cadence-admin','admin')],'0'.repeat(40));
  try {await delay(1_000);} finally {await plane.stop();Engine.prototype.reconcile=original;}
  assert.equal(ticks,0,`reconciled ${ticks} times in its first second`);
});
