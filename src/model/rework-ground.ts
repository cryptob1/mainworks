import type { Work } from './work.js';
import type {} from './merge-ledger.js'; // Work.mergeLedger

/** The ground's name, as the binding of the rework the loop applies names it (`<head>:merge-writer-trial-failed`). */
export const mergeWriterTrialGround = 'merge-writer-trial-failed';
/**
 * How the merge writer's `merge.refused` reason opens when the trial of the head failed (a conflict,
 * a failed build step or failing tests), as against a push the base moved under (`base moved N
 * times`), which refuses nothing about the head and leaves it queued.
 */
export const trialFailurePrefix = 'trial failed';
/** GY-3423: how a feature's or bug's refusal opens when every proof already passed on the base tip. */
export const proofPassesOnBasePrefix = `${trialFailurePrefix}: the proof already passes before the change`;

/**
 * GY-1524. The ground a failed trial of the current head gives: the control plane's own merge
 * writer trial-merged exactly this candidate onto the base tip, built and ran its tests, and
 * recorded `merge.refused` naming what failed (model/merge-ledger.ts). Nothing but a new head can
 * pass that trial.
 * A refusal for another head, a revert refusal, or a `base moved` refusal grounds nothing.
 */
export function trialFailedGround(work: Pick<Work, 'candidate' | 'mergeLedger'>): string | null {
  const ledger = work.mergeLedger, candidate = work.candidate;
  if (!ledger || !candidate || ledger.state !== 'refused' || !ledger.refusal || ledger.refusal.kind !== 'merge') return null;
  if (ledger.head?.toLowerCase() !== candidate.sha.toLowerCase() || !ledger.refusal.reason.startsWith(trialFailurePrefix)) return null;
  return `the merge writer's trial of candidate ${candidate.sha.slice(0, 12)} failed (${ledger.refusal.reason})`;
}

/** The station that refused an attempt, as the rework brief ledger names it (GY-3636). */
export type ReworkStation = 'review' | 'product review' | 'merge trial' | 'acceptance' | 'base moved';
export const attemptSummaryMax = 200;
const reworkCapLimit = 3;

export type ReworkHistoryEntry = { attempt: number; reason: string; binding: string | null; at: string };

/** Whether a rework was caused by the base branch moving (merge/sync conflict), which does not count toward the 3-failure cap. */
export function isBaseMovedRework(entry: Pick<ReworkHistoryEntry, 'binding' | 'reason'>): boolean {
  const binding = entry.binding ?? '';
  if (binding.endsWith(':conflict') || binding.includes(':sync:')) return true;
  return /The base moved:|conflicts with base branch|trial failed: the merge conflicts in /i.test(entry.reason);
}

/** The station that refused a rework entry. */
export function reworkStation(entry: Pick<ReworkHistoryEntry, 'binding' | 'reason'>): ReworkStation {
  if (isBaseMovedRework(entry)) return 'base moved';
  const binding = entry.binding ?? '';
  if (binding.includes(':product-verdict:') || /product review requested changes/i.test(entry.reason)) return 'product review';
  if (binding.includes(':verdict:') || /requested changes on /i.test(entry.reason)) return 'review';
  if (binding.includes(`:${mergeWriterTrialGround}`) || /merge writer's trial|trial failed/i.test(entry.reason)) return 'merge trial';
  if (binding.includes(':proof:') || binding.includes(':proof-exhausted') || binding.includes(':human:')
    || /trusted proof failed|producer attempts|failed a person's check|does not exercise its criterion/i.test(entry.reason)) return 'acceptance';
  return 'review';
}

/** Collapse whitespace to a single line and cap at `limit` characters. */
export function oneLineSummary(reason: string, limit = attemptSummaryMax): string {
  const compact = reason.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

/**
 * Counted automatic refusals since the last Lead decision (`binding === null`).
 * Base-moved conflicts do not count toward the cap (GY-3636 AC-2).
 */
function reworkCapRefusals(work: Pick<Work, 'stage' | 'reworkHistory'>): ReworkHistoryEntry[] {
  if (work.stage === 'done' || !work.reworkHistory?.length) return [];
  let start = 0;
  for (let i = work.reworkHistory.length - 1; i >= 0; i--) {
    if (work.reworkHistory[i]!.binding === null) { start = i + 1; break; }
  }
  return work.reworkHistory.slice(start).filter(entry => !isBaseMovedRework(entry));
}

/** Whether automatic launches are held for the Lead after reaching the 3-refusal cap. */
export const reworkCapHeld = (work: Pick<Work, 'stage' | 'reworkHistory'>): boolean =>
  reworkCapRefusals(work).length >= reworkCapLimit;

/** The status line `master status` shows for an item held at the rework cap. */
export const reworkCapLabel = (work: Pick<Work, 'stage' | 'reworkHistory'>): string =>
  `needs the Lead: failed ${reworkCapRefusals(work).length} times`;

/** The one decision raised for the master when an item hits the 3-refusal cap. */
export function reworkCapCause(work: Pick<Work, 'id' | 'key' | 'stage' | 'reworkHistory'>): { key: string; detail: string } | null {
  const refusals = reworkCapRefusals(work);
  if (refusals.length < reworkCapLimit) return null;
  const listed = refusals.map((entry, index) => `(${index + 1}) Attempt ${entry.attempt} (${reworkStation(entry)}): ${oneLineSummary(entry.reason, attemptSummaryMax)}`).join('; ');
  return {
    key: `rework-cap:${work.id}`,
    detail: `${work.key}: ${reworkCapLabel(work)}; no further attempt is launched automatically. Refusals: ${listed}. Decide one of: revise the requirements (graphyard master requirements ${work.key} FILE REASON), split into smaller items (graphyard master create FILE and close ${work.key}), or park with a summary (graphyard master hold ${work.key} REASON or graphyard master close ${work.key} REASON).`,
  };
}
