import type { Work } from './model.js';

/**
 * GY-863. The landing check's per-file record may carry the blob the three-way merge of the head
 * onto the landing commit holds at the path, computed by the control plane from the three blobs'
 * contents (github.ts `decideLandingMerges`); where it is present the guard compares it, not the
 * head's blob, with the landing commit's version.
 */
declare module './model/work.js' {
  interface ScopeFile {
    /** The merged result's blob when the three-way merge was computed and was clean; absent otherwise. */
    mergeSha?: string | null;
  }
}

/**
 * Delivered work items whose observed diff covers the path. A pull request the provider reports
 * merged shipped its files whether or not its delivery is recorded yet.
 */
export function shippedBy(path: string, all: Work[]): string[] {
  return all.filter(item => ((item.stage === 'done' && !item.closure) || !!item.observation?.merged) && (item.observation?.files ?? []).includes(path)).map(item => item.key);
}

/**
 * GY-744. An open candidate in the head's history that git shows already landed: its head, or its
 * pull request's merge commit, is an ancestor of the base branch tip. The owning item's recorded
 * state lags a merge made outside the queue, so the landing check (model/landing-check.ts)
 * asks git before naming any candidate unlanded; such a peer is neither `foreign` nor `carried`,
 * none of its files is read as a revert, and its merge is reconciled at once (engine.ts).
 */
interface LandedCandidate { key: string; pr: number; head: string; mergeSha: string | null }
declare module './model/landing-check.js' {
  interface LandingCheck {
    /** The open candidates in this head's history that git shows already on the base branch tip (GY-744). */
    landed?: LandedCandidate[];
  }
}
