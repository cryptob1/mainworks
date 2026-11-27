import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BaseRefresh } from '../src/model/base-refresh.js';
import { carriedApproval, currentCarry, evidenceBindsCandidate, refreshedCarriedApproval, type Evidence, type Observation, type QueueCarry, type TipMerge, type Work } from '../src/model.js';
import { assertReviewCandidate } from '../src/reviewer.js';
import { diagnose } from '../src/coordination.js';

// Each test is named for the proof it produces, so acceptance evidence maps to one executed
// case per required proof.
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1'), P = sha40('c1'), TIP = sha40('d1');
const at = '2026-09-19T08:00:00.000Z';
const authored = (overrides: Partial<TipMerge> = {}): TipMerge => ({ from: H, parents: [H, P], author: 'graphyard[bot]', authoredByApp: true, conflicts: false, baseChanges: ['src/other.ts', 'docs/other.md'], ...overrides });
const evidenceRecord = (proof: string, overrides: Partial<Evidence> = {}): Evidence => ({ id: `ev-${proof}`, proof, sha: H, baseSha: B, policyRevision: 1, producer: 'ci-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at, ...overrides });
/** The carry decision recorded when approved head H on B was brought onto base P as Mainworks-authored TIP. */
const decided = (): QueueCarry => ({ from: { sha: H, baseSha: B }, to: { sha: TIP, baseSha: P }, policyRevision: 1, at, predecessor: 'GY-1', changedFiles: ['src/other.ts', 'docs/other.md'], reviewedFiles: ['src/queue.ts', 'tests/queue.test.ts'],
  approval: { carried: true, provider: 'github', reviewer: 'reviewer[bot]', sha: H, reviewId: 900, originalSha: H, reason: 'GY-1 changed none of the 2 reviewed files' },
  evidence: [{ proof: 'unit:queue', carried: true, evidenceId: 'ev-unit:queue', producer: 'ci-runner', reason: 'scope disjoint' }, { proof: 'integration:docs', carried: false, evidenceId: 'ev-docs', producer: 'ci-runner', reason: 'scope touched' }] });
const refreshed = (carry: QueueCarry): BaseRefresh => ({ from: { sha: H, baseSha: B }, base: P, baseTree: sha40('7e'), policyRevision: 1, at, head: TIP, conflict: null, merge: authored(), carry });

test('unit:queue-authored-tip-carry — a carried binding applies only to the exact refreshed head and policy it was decided for, and only for the policy\'s provider', () => {
  const carry = decided();
  const work = { candidate: { sha: TIP, baseSha: P, pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' }, policyRevision: 1, policy: { checks: ['test'], review: true }, baseRefresh: refreshed(carry) } as unknown as Work;
  assert.equal(currentCarry(work), carry);
  assert.equal(carriedApproval(work)?.reviewer, 'reviewer[bot]');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue')), true, 'the carried record binds the tip');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('integration:docs', { id: 'ev-docs' })), false, 'a re-required record does not');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue', { id: 'ev-later' })), false, 'only the exact record the decision named');
  assert.equal(evidenceBindsCandidate(work, evidenceRecord('unit:queue', { sha: TIP, baseSha: P })), true, 'an exact binding always applies');
  assert.equal(currentCarry({ ...work, policyRevision: 2 }), null, 'a policy revision invalidates the carry');
  assert.equal(currentCarry({ ...work, candidate: { ...work.candidate!, sha: sha40('e9') } }), null, 'another head is not the tip');

});

test('unit:queue-real-base-tip — the review launcher refuses a candidate behind the real base tip that does not merge cleanly, and diagnose reports it', () => {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker' };
  // GY-191: behind and mergeable is reviewed as it stands; only a head GitHub reports conflicting is refused.
  const mergeable = { key: 'GY-7', policy: { checks: [], review: true }, submission: { epoch: 1, pr: 7 }, candidate, reworkRequested: false,
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], at, prState: 'open', draft: false, baseTip: sha40('b2'), baseTree: sha40('7b'), baseTipContained: false } } as unknown as Work;
  assert.equal(assertReviewCandidate(mergeable, at).sha, H, 'a mergeable head behind the base is reviewed');
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: false, conflicting: true, protected: true, files: [], scopeFiles: [], at, prState: 'open', draft: false, baseTip: sha40('b2'), baseTree: sha40('7b'), baseTipContained: false } as Observation;
  const work = { key: 'GY-7', policy: { checks: [], review: true }, submission: { epoch: 1, pr: 7 }, candidate, observation, reworkRequested: false, ready: true, dependencies: [], workspaces: [], criteria: [], evidence: [], gates: [], violations: [], scenarioRequirements: [] } as unknown as Work;
  assert.throws(() => assertReviewCandidate(work, at), new RegExp(`GY-7 candidate ${H.slice(0, 12)} does not contain the base branch tip ${sha40('b2').slice(0, 12)}; .* Run mainworks sync GY-7`));
  const behind = diagnose(work, [work], Date.parse(at)).find(entry => entry.kind === 'base-behind')!;
  assert.match(behind.message, new RegExp(`does not contain the base branch tip ${sha40('b2').slice(0, 12)}`));
  // Bringing the head onto the moved tip is the control plane's work now, not a worker sync round.
  assert.match(behind.next, /the reconciliation job merges the base into this branch/);
  work.observation = { ...observation, baseTipContained: true };
  assert.equal(assertReviewCandidate(work, at).sha, H);
  assert.equal(diagnose(work, [work], Date.parse(at)).some(entry => entry.kind === 'base-behind'), false);
});

// ---- GY-831: a refreshed head whose carried approval is stale is re-reviewed or re-bound ----------

/** A base refresh of reviewed head H whose carried approval names review 800 of an earlier pull request's commit. */
const OLD = sha40('0d1');
function staleCarry(reviews: Observation['reviews'] = []) {
  const carry = decided();
  carry.approval = { carried: true, provider: 'github', reviewer: 'graphyard-reviewer[bot]', sha: OLD, reviewId: 800, originalSha: OLD, reason: 'carried from the earlier pull request' };
  const candidate = { sha: TIP, baseSha: P, pr: 371, branch: 'graphyard/gy-470-2', author: 'worker' };
  return { key: 'GY-470', candidate, policyRevision: 1, policy: { checks: ['test'], review: true }, baseRefresh: refreshed(carry),
    observation: { candidate, reviews, checks: [], merged: false, mergeSha: null, protected: true, mergeable: true, files: [], scopeFiles: [], at, prState: 'open', draft: false } } as unknown as Work;
}

test('unit:carried-approval-rebinds — a carried binding from an earlier pull request is refreshed by the bound reviewer\'s newer approval of the head the tip was built from', () => {
  const work = staleCarry(), carried = carriedApproval(work)!;
  assert.equal(carried.originalSha, OLD);
  // The record refreshes the binding as soon as an observation shows the newer approval of H,
  // dismissed by GitHub on the tip push or not; a later change request refreshes nothing.
  const dismissed = staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'DISMISSED', dismissal: { verdict: 'approved', mergeBase: true } } as Observation['reviews'][number]]);
  const refreshed = refreshedCarriedApproval(dismissed)!;
  assert.deepEqual([refreshed.carried, refreshed.reviewer, refreshed.reviewId, refreshed.originalSha, refreshed.sha], [true, 'graphyard-reviewer[bot]', 5327788286, H, H]);
  assert.match(refreshed.reason, new RegExp(`approval of ${H.slice(0, 12)} by graphyard-reviewer\\[bot\\] \\(review 5327788286\\), the head tip ${TIP.slice(0, 12)} was built from, replaces the carried approval of ${OLD.slice(0, 12)}`));
  // A dismissal that is not from mergeBase (manually dismissed) does not refresh the binding.
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'DISMISSED', dismissal: { verdict: 'approved', mergeBase: false } } as Observation['reviews'][number]])), null, 'a deliberately dismissed approval does not re-bind');
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }, { id: 5327788290, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'CHANGES_REQUESTED' }])), null);
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 700, reviewer: 'graphyard-reviewer[bot]', sha: H, state: 'APPROVED' }])), null, 'an older approval is not newer than the binding');
  assert.equal(refreshedCarriedApproval(staleCarry([{ id: 5327788286, reviewer: 'someone-else', sha: H, state: 'APPROVED' }])), null, 'only the carried reviewer re-binds its own approval');
});
