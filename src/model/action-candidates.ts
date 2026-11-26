import type { ActionRow } from './actions.js';
import type { Work } from './work.js';

/**
 * Whether a row is what stands between its item and the merge: a `resync` or `merge` row on an item
 * already at the merge stage. Every other gate has passed, so nothing but this row holds it.
 */
const unblocksMerge = (work: Work, row: ActionRow) => work.stage === 'merge' && (row.kind === 'resync' || row.kind === 'merge');

/**
 * The order executors claim rows in (GY-1132): the item's priority first, then rows that unblock a
 * merge before any other kind, then the oldest request, then the id so the order is total.
 *
 * Age alone let 34 dispatch rows, hours old and failing on every attempt for want of a worker,
 * hold a P0 item's resync for 25 minutes. Age still decides among peers, so the row open longest
 * among its priority and kind is taken first and none of them starves; a failed row waits out its
 * `retryAt` (`claimable`), and the rows behind it are claimed meanwhile.
 */
export const claimOrder = (a: { work: Work; row: ActionRow }, b: { work: Work; row: ActionRow }): number =>
  (a.work.priority ?? 2) - (b.work.priority ?? 2)
  || Number(!unblocksMerge(a.work, a.row)) - Number(!unblocksMerge(b.work, b.row))
  || compare(requestedTime(a.row), requestedTime(b.row))
  || compare(a.row.id, b.row.id);
/** A missing or malformed `requestedAt` counts as oldest, as the SQL's `NULLS FIRST` does, so the sort stays total. */
const requestedTime = (row: ActionRow) => { const time = Date.parse(row.requestedAt); return Number.isNaN(time) ? -Infinity : time; };
/** Code-unit order, which is the SQL's `COLLATE "C"` for these ASCII ids; `localeCompare` could disagree with it. */
const compare = <T extends number | string>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Whether this row steps aside for `executor` once: its last record is that executor's failed
 * attempt, and it has not yet yielded to it since. One executor then never takes the same failing
 * row twice running while another row is claimable, yet the row yields only one turn — decided
 * from the row alone, so it holds whichever other items the claim happened to load. Claiming the
 * row clears the mark (`claimAction`), so its next failure yields once again.
 */
export const yieldsTo = (row: ActionRow, executor: string) => {
  const last = row.history.at(-1);
  return last?.event === 'failed' && last.executor === executor && row.yielded !== executor;
};

