import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { useTestStore } from './helpers/test-store.js';
import { Engine } from '../src/engine.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { reconcileAutoDispatch, productReviewNeed } from '../src/model-boundary/dispatch.js';
import { reconcileActions } from '../src/model-boundary/actions.js';
import { nextAction } from '../src/model-boundary/next-action.js';
import { productReviewRefusal } from '../src/model-boundary/product-review.js';
import { neededRework } from '../src/daemon/rework.js';
import { staleReviewReason } from '../src/reviewer.js';
import { recordReviewLaunch, recordReviewVerdict, tokenHashOf } from '../src/server/review-verdict.js';
import type { Principal, Work } from '../src/model.js';
import type { ProductReview } from '../src/model/product-review.js';
import type { Store } from '../src/store.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3684 AC-1: a product review verdict on a head satisfies the product review gate for that head
// after main moves; a new product review is required only when the head itself changes or its merge
// onto the current main conflicts. The request-review action's binding for a product review names
// the head and policy revision, not the base tip, so a main move neither resets the request nor
// discards a review in flight.

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const B0 = 'a'.repeat(40);
const B1 = 'b'.repeat(40);
const B2 = 'c'.repeat(40);
const B3 = 'd'.repeat(40);
const B4 = 'e'.repeat(40);
const shaOf = (seed: string) => createHash('sha1').update(seed).digest('hex');

function featureOn(key: string, head: string, base: string, at: string, options: { mergeBase?: string | null; conflicting?: boolean } = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 1, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker-1' };
  return workFixture({ id: randomUUID(), key, title: `Feature ${key}`, priority: 1, criteria: [{ id: 'AC-1', text: 'Works end to end', proofs: ['e2e:smoke'] }],
    stage: 'review', revision: 3, createdAt: at, updatedAt: at, stageEnteredAt: at, epoch: 1,
    workspaces: [{ host: 'h', path: `/w/${key}`, branch: candidate.branch, epoch: 1, owner: 'worker-1' }], candidate, submission: { epoch: 1, pr: 1 },
    evidence: [{ id: 'e1', proof: 'e2e:smoke', sha: head, baseSha: base, policyRevision: 1, producer: 'merge-trial', trusted: true, result: 'pass', executed: 1, skipped: 0, at }],
    gates: [], implementers: ['worker-1'],
    pipeline: { attempts: [], submittedAt: at, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: {
      source: 'control-plane', at, candidate, checks: [],
      reviews: [{ id: 1, reviewer: 'code-reviewer', state: 'APPROVED', sha: head, submittedAt: at }],
      merged: false, mergeSha: null, mergeable: !options.conflicting, ...(options.conflicting ? { conflicting: true } : {}), protected: false,
      files: ['web/feature.ts'],
      scopeFiles: [{ path: 'web/feature.ts', status: 'added' as const, sha: shaOf(`${key}:${head}`), additions: 10, deletions: 0, binary: false }],
      baseTip: base, baseTipContained: base === B0,
      ...(options.mergeBase !== null ? { mergeBase: options.mergeBase ?? B0 } : {}),
    } as never,
    productReview: null,
  });
}

function moveMain(work: Work, newBase: string, at: string, options: { keepMergeBase?: boolean; conflicting?: boolean } = {}) {
  work.candidate = { ...work.candidate!, baseSha: newBase };
  work.observation = {
    ...work.observation!,
    at,
    candidate: { ...work.observation!.candidate, baseSha: newBase },
    baseTip: newBase,
    baseTipContained: false,
    mergeable: !options.conflicting,
    ...(options.conflicting ? { conflicting: true } : { conflicting: undefined }),
    ...(options.keepMergeBase === false ? { mergeBase: undefined } : {}),
  };
}

let store: Store;
let engine: Engine;

useTestStore('product-review-stands-for-its-head', {}, ctx => {
  ({ store, engine } = ctx);
  engine.gitRunner = null;
});

test('unit:product-review-stands-for-its-head — approved, main moves three times, still satisfied; head changes, required again; request-review binding excludes base tip', () => {
  const t0 = new Date('2026-11-22T10:00:00.000Z');
  const item = featureOn('GY-7001', H1, B0, t0.toISOString());
  item.gates = evaluate(item, [item], t0).gates;
  reconcileAutoDispatch(item, [item], t0);
  reconcileActions(item, [item], t0);

  const initialAction = nextAction(item, [item], t0);
  assert.ok(initialAction, 'missing product review produces a next action');
  assert.equal(initialAction.kind, 'request-review');
  assert.ok(initialAction.binding.includes(H1.slice(0, 12)), 'binding names the head');
  assert.ok(initialAction.binding.includes(`:${item.policyRevision}:`), 'binding names the policy revision');
  assert.ok(!initialAction.binding.includes(B0.slice(0, 12)), 'binding must not name the base tip');

  const initialRow = item.actionQueue!.actions[0]!;
  const initialRequestId = item.autoDispatch!.product!.id;
  const initialRequestedAt = item.autoDispatch!.product!.requestedAt;

  // Main moves while product review is still pending: neither the action row nor the dispatch request resets.
  const t1 = new Date('2026-11-22T10:20:00.000Z');
  moveMain(item, B1, t1.toISOString());
  item.gates = evaluate(item, [item], t1).gates;
  reconcileAutoDispatch(item, [item], t1);
  reconcileActions(item, [item], t1);

  assert.equal(item.actionQueue!.actions.length, 1);
  assert.equal(item.actionQueue!.actions[0]!.id, initialRow.id, 'action row id stays unchanged after main moves');
  assert.equal(item.actionQueue!.actions[0]!.requestedAt, initialRow.requestedAt, 'action row requestedAt is not reset when main moves');
  assert.equal(item.autoDispatch!.product!.id, initialRequestId, 'product dispatch request id stays unchanged');
  assert.equal(item.autoDispatch!.product!.requestedAt, initialRequestedAt, 'product dispatch requestedAt stays unchanged');

  // Product review approves H1.
  const verdict: ProductReview = {
    sha: H1, baseSha: B0, verdict: 'approved', reviewer: 'product-reviewer',
    findings: 'Walked the feature; everything works.', screenshots: [], at: t1.toISOString(),
  };
  item.productReview = verdict;

  // Main moves three times: B1 -> B2 -> B3 -> B4. Approval on H1 still satisfies the product review gate.
  for (const [index, base] of [B1, B2, B3].entries()) {
    const t = new Date(t1.getTime() + (index + 1) * 20 * 60_000);
    moveMain(item, base, t.toISOString());
    const judged = evaluate(item, [item], t);
    assert.equal(productReviewRefusal(item), null, `product review still stands after main move #${index + 1}`);
    assert.equal(judged.gates.find(g => g.name === 'review')!.passed, true, `review gate stays passed after main move #${index + 1}`);
    assert.equal(productReviewNeed(item).needed, false, `no new product review needed after main move #${index + 1}`);
  }

  // Merge onto current main conflicts: item returns for rework (sync produces a new head).
  const tConflict = new Date('2026-11-22T11:30:00.000Z');
  moveMain(item, B4, tConflict.toISOString(), { conflicting: true });
  const conflictRework = neededRework(item);
  assert.ok(conflictRework, 'a conflict with main sends the head back to rework');
  assert.match(conflictRework.reason, /conflicts with base branch tip/);

  // Head changes to H2: product review is required again, and its new action binding names H2 (not B4).
  const tNewHead = new Date('2026-11-22T12:00:00.000Z');
  const nextHead = featureOn('GY-7001', H2, B4, tNewHead.toISOString());
  nextHead.productReview = verdict;
  nextHead.gates = evaluate(nextHead, [nextHead], tNewHead).gates;
  assert.equal(productReviewRefusal(nextHead), 'Product review of the current commit is required');
  assert.equal(nextHead.gates.find(g => g.name === 'review')!.passed, false);
  assert.equal(productReviewNeed(nextHead).needed, true);
  const newHeadAction = nextAction(nextHead, [nextHead], tNewHead);
  assert.equal(newHeadAction?.kind, 'request-review');
  assert.ok(newHeadAction!.binding.includes(H2.slice(0, 12)));
  assert.ok(!newHeadAction!.binding.includes(B4.slice(0, 12)));
});

test('unit:product-review-stands-for-its-head — review in flight when main moves, its verdict is accepted and ledger record stays current', async () => {
  const t0 = new Date('2026-11-22T10:00:00.000Z');
  const item = featureOn('GY-7002', H1, B0, t0.toISOString(), { mergeBase: null });
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1, $2)', [item.id, JSON.stringify(item)]);

  const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
  const reviewer: Principal = { id: 'product-reviewer', role: 'reader' };
  const token = 'f'.repeat(64);
  const services = { engine } as never;

  await recordReviewLaunch(services, coordinator, item.id, {
    reviewer: reviewer.id,
    head: H1,
    baseTip: B0,
    tokenHash: tokenHashOf(token),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    postMerge: false,
    product: true,
  }, `launch-${randomUUID()}`);

  // Move main to B1 while the product review is in flight (even without mergeBase recorded).
  const stored = (await store.pool.query('SELECT document FROM work_items WHERE id = $1', [item.id])).rows[0]!.document as Work;
  moveMain(stored, B1, new Date('2026-11-22T10:15:00.000Z').toISOString(), { keepMergeBase: false });
  await store.pool.query('UPDATE work_items SET document = $2 WHERE id = $1', [item.id, JSON.stringify(stored)]);

  // The pending product review ledger record is not staled by main moving.
  assert.equal(
    staleReviewReason({ key: stored.key, sha: H1, baseSha: B0, policyRevision: 1, product: true } as never, [stored]),
    null,
    'a product review in flight is not staled when main moves',
  );

  // The in-flight product reviewer posts APPROVE for H1 after main moved to B1: accepted!
  const result = await recordReviewVerdict(services, reviewer, item.id, {
    event: 'APPROVE',
    body: 'Verified the feature end to end.',
    sha: H1,
    token,
  }, `verdict-${randomUUID()}`) as { recorded: boolean; state: string; product: boolean };

  assert.equal(result.recorded, true);
  assert.equal(result.state, 'approved');
  assert.equal(result.product, true);

  const afterVerdict = (await store.pool.query('SELECT document FROM work_items WHERE id = $1', [item.id])).rows[0]!.document as Work;
  assert.equal(afterVerdict.productReview?.verdict, 'approved');
  assert.equal(afterVerdict.productReview?.sha, H1);
  assert.equal(afterVerdict.gates.find(g => g.name === 'review')?.passed, true);

  // If the head itself changes while a product review is in flight, its verdict is still refused.
  const itemChanged = featureOn('GY-7003', H1, B0, t0.toISOString(), { mergeBase: null });
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1, $2)', [itemChanged.id, JSON.stringify(itemChanged)]);
  const token2 = 'e'.repeat(64);
  await recordReviewLaunch(services, coordinator, itemChanged.id, {
    reviewer: reviewer.id,
    head: H1,
    baseTip: B0,
    tokenHash: tokenHashOf(token2),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    postMerge: false,
    product: true,
  }, `launch-${randomUUID()}`);
  const movedHead = (await store.pool.query('SELECT document FROM work_items WHERE id = $1', [itemChanged.id])).rows[0]!.document as Work;
  movedHead.candidate = { ...movedHead.candidate!, sha: H2 };
  movedHead.observation = { ...movedHead.observation!, candidate: { ...movedHead.observation!.candidate, sha: H2 } };
  await store.pool.query('UPDATE work_items SET document = $2 WHERE id = $1', [itemChanged.id, JSON.stringify(movedHead)]);

  await assert.rejects(
    () => recordReviewVerdict(services, reviewer, itemChanged.id, {
      event: 'APPROVE',
      body: 'Stale head verdict.',
      sha: H1,
      token: token2,
    }, `verdict-${randomUUID()}`),
    /head changed since launch/i,
  );
});
