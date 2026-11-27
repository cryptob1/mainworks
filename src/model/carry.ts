import type { Evidence } from './evidence.js';
import type { ReviewProvider } from './review.js';
import type { Work } from './work.js';
import { docsSignoffProof } from './docs-signoff.js';

/**
 * Binding carry across a Mainworks-authored merge of the base into a candidate (a base refresh).
 *
 * A review and every trusted proof bind to one exact commit. When the control plane replaces an
 * approved, proven head H with a tip H' that Mainworks itself produced — a two-parent merge of H
 * and the commit H' will land on, authored by the control-plane App, with no conflict resolved —
 * the two commits are provably the same reviewed content plus already-validated history. Only
 * then is a binding carried. The review judges whether the change is right and the proofs what it
 * does; the combined tip's CI, which always runs again, judges whether the combination works. So
 * the first ground is the change's own diff (GY-330): when the tip's diff against its merge base
 * has the same patch-id as the replaced head's diff against its own, the change nobody changed
 * keeps its approval and every proof, even where the base edited another hunk of a reviewed file.
 * Where that is not shown — the diff changed, or a side of it could not be read completely — a
 * binding carries only as far as the predecessor's changes let it: an approval when the
 * predecessor touched none of the reviewed files, and a proof when its declared scope is disjoint
 * from those changes. An attestation (GY-615) declares no scope: it carries only on the first
 * ground, never over a changed patch. Everything else is re-required with the reason recorded. The decision is
 * made once, at publication, from facts the control plane observed itself; it is never asserted by
 * a worker, a producer, or a reviewer.
 */

/** What Mainworks's merge produced when it published a tip, as GitHub reports the commit. */
export interface TipMerge {
  /** The head the tip replaced: the commit every carried binding was made against. */
  from: string;
  /** Parents of the tip commit; a carried tip has exactly the replaced head and its predicted base. */
  parents: string[];
  /** GitHub login of the tip commit's author, or null when GitHub reported none. */
  author: string | null;
  /** The author is the control-plane App's own bot identity. */
  authoredByApp: boolean;
  /** The merge needed a conflict resolved; Mainworks's provider merge never does, and a resolved merge is never carried. */
  conflicts: boolean;
  /** Paths changed between the replaced head's bound base and the predicted base, or null when GitHub could not list them completely. */
  baseChanges: string[] | null;
  /**
   * The candidate's own diff on each side of the merge, as patch-ids (GY-330): `reviewed` from
   * GitHub's compare of the replaced head against its merge base with the bound base, `tip` from
   * the compare of the tip against its merge base with the predicted base. A side is null when
   * GitHub could not list it completely (a truncated list, or a file with neither a textual patch
   * nor a blob SHA);
   * absent on records that predate the rule.
   */
  diff?: { reviewed: string | null; tip: string | null } | null;
}
/**
 * What a carry decision rested on (GY-330): `diff unchanged` — the tip's own diff has the reviewed
 * diff's patch-id, so every binding carried; `diff changed` — it has another, so each binding was
 * decided by the files rule; `files` — no patch-id could be compared, so the files rule decided.
 */
export interface CarryGround { rule: 'diff unchanged' | 'diff changed' | 'files'; patchId: string | null; tipPatchId: string | null }
/** The identity behind an exact-commit approval, as the review gate accepted it. */
export interface ApprovalIdentity { provider: ReviewProvider; reviewer: string; sha: string; reviewId?: number; reviewerApp?: string }
export interface CarriedApproval extends ApprovalIdentity { carried: true; originalSha: string; reason: string }
/**
 * A binding that is not carried. `refused` names the carried approval the guarded merge could not
 * re-post (GY-831), so the same dismissed review is never restored over the refusal.
 */
export interface RequiredApproval { carried: false; reason: string; refused?: { reviewer: string; reviewId?: number; originalSha: string; at: string } }
export interface CarriedProof { proof: string; carried: boolean; evidenceId?: string; producer?: string; reason: string }
export interface QueueCarry {
  from: { sha: string; baseSha: string }; to: { sha: string; baseSha: string }; policyRevision: number; at: string;
  /** What the head was brought onto: the base branch (records from before GY-1236 may name a merge-queue entry). */
  predecessor: string;
  /** Paths the predecessor changed relative to the replaced head's bound base; null when unknown. */
  changedFiles: string[] | null;
  /** Paths the replaced head changed: what the carried review actually read. */
  reviewedFiles: string[];
  approval: CarriedApproval | RequiredApproval;
  evidence: CarriedProof[];
  /** The ground the decision rested on; absent on decisions recorded before GY-330. */
  ground?: CarryGround;
}

const short = (sha: string) => sha.slice(0, 12);
/** The identity a carried approval names, in the reason every status view shows: who, which review, and the commit it was given on. */
const approvedBy = (approval: ApprovalIdentity) => `approval of ${short(approval.sha)} by ${approval.reviewer}${approval.reviewId !== undefined ? ` (review ${approval.reviewId})` : ''}`;
export type CarryBearer = Pick<Work, 'candidate' | 'baseRefresh' | 'policyRevision' | 'mergeRefusal'>;
/**
 * The carry decision that applies to the current candidate, under the current policy: the one
 * decided when the control plane brought the candidate onto a moved base branch.
 */
export function currentCarry(work: CarryBearer): QueueCarry | null {
  const candidate = work.candidate;
  if (!candidate) return null;
  const applies = (carry: QueueCarry | null | undefined) => carry && carry.to.sha === candidate.sha
    && carry.to.baseSha === candidate.baseSha && carry.policyRevision === work.policyRevision ? carry : null;
  const refresh = work.baseRefresh;
  if (refresh?.head === candidate.sha) { const carried = applies(refresh.carry); if (carried) return carried; }
  // A candidate the guarded merge refused kept its decision on the refusal (GY-831), approval
  // re-required, so its carried proofs still bind it.
  const refusal = work.mergeRefusal;
  return refusal?.sha === candidate.sha && refusal.baseSha === candidate.baseSha ? applies(refusal.carry) : null;
}
/**
 * True when a trusted evidence record binds the current candidate: exactly, or carried across a
 * Mainworks-authored commit. The decision names the exact record it carried, which is what lets a
 * record carried more than once — across two base refreshes — still be the one the latest
 * decision names.
 */
export function evidenceBindsCandidate(work: CarryBearer & { observation?: Work['observation'] }, evidence: Pick<Evidence, 'id' | 'proof' | 'sha' | 'baseSha' | 'docsDigest'>): boolean {
  const candidate = work.candidate;
  if (!candidate) return false;
  if (evidence.sha === candidate.sha && evidence.baseSha === candidate.baseSha) return true;
  // A person (GY-2986) or the master (GY-3429) checked the commit itself: the base tip moving
  // under it asks them nothing new. Trial evidence keeps its base binding.
  if (evidence.sha === candidate.sha && /^(human|manual):/.test(evidence.proof)) return true;
  // A docs sign-off (GY-3716) judged the documentation, so it stands while the head's docs are byte-identical.
  if (docsSignoffProof(evidence.proof) && evidence.docsDigest && work.observation?.candidate.sha === candidate.sha && work.observation.docsDigest === evidence.docsDigest) return true;
  const carry = currentCarry(work);
  return !!carry && carry.evidence.some(entry => entry.carried && entry.proof === evidence.proof && entry.evidenceId === evidence.id);
}
/** The approval carried onto the current candidate, when the decision carried one for the policy's provider. */
export function carriedApproval(work: Work): CarriedApproval | null {
  const carry = currentCarry(work), approval = carry?.approval;
  if (!approval?.carried || approval.provider !== (work.policy.reviewProvider ?? 'github')) return null;
  return approval;
}
/**
 * The commit the current candidate was built from, whose review the carried approval stands for
 * (GY-831): the head the carry decision replaced.
 */
export function carriedReviewedHead(work: CarryBearer): string | null {
  return currentCarry(work)?.from.sha ?? null;
}
/**
 * The carried approval re-bound to a newer approval of the tip's reviewed head (GY-831), or null
 * when the observation shows none. The carried binding can name a review GitHub no longer holds —
 * one given on an earlier pull request of the item — while the same reviewer has since approved
 * the very head the tip was built from; that newer approval is what the re-post must use. Only
 * the carried reviewer's own approval counts (a dismissed one when its recorded verdict was an
 * approval), never one that reviewer followed with a change request.
 */
export function refreshedCarriedApproval(work: Work): CarriedApproval | null {
  const carried = carriedApproval(work), head = carriedReviewedHead(work), observation = work.observation, candidate = work.candidate;
  if (!carried || carried.provider !== 'github' || !head || !observation || !candidate || observation.candidate.sha !== candidate.sha) return null;
  const reviewer = carried.reviewer.toLowerCase(), baseline = work.formalReviewBaseline;
  const own = (observation.reviews ?? []).filter(review => review.reviewer.toLowerCase() === reviewer && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state));
  const approved = (review: NonNullable<Work['observation']>['reviews'][number]) => review.state === 'APPROVED'
    || review.state === 'DISMISSED' && (review as { dismissal?: { verdict?: string; mergeBase?: boolean } }).dismissal?.verdict === 'approved' && (review as { dismissal?: { mergeBase?: boolean } }).dismissal?.mergeBase;
  const latest = own.at(-1);
  if (!latest || latest.state === 'CHANGES_REQUESTED') return null;
  const newest = own.filter(review => review.sha === head && approved(review) && Number.isSafeInteger(review.id)
    && (!work.formalReviewResetRequired || baseline?.pr === candidate.pr && baseline.policyRevision === work.policyRevision && !baseline.reviewIds.includes(review.id!))).at(-1);
  if (!newest || carried.reviewId !== undefined && newest.id! <= carried.reviewId) return null;
  if (carried.reviewId === newest.id && carried.originalSha === head) return null;
  return { ...carried, sha: head, originalSha: head, reviewId: newest.id!,
    reason: `approval of ${short(head)} by ${carried.reviewer} (review ${newest.id}), the head tip ${short(candidate.sha)} was built from, replaces the carried ${approvedBy({ ...carried, sha: carried.originalSha })} as the approval carried to the tip` };
}

