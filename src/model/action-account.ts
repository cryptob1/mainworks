import type { NextAction } from './action-kinds.js';
/**
 * The vocabulary for what an item needs, or for why it needs nothing.
 *
 * It is separated from the computation in `next-action.ts` for the same reason `action-kinds.ts`
 * is: everything downstream — master status, the coordination loop, the dashboard — reads this
 * without computing anything, and adding a kind of wait means answering here what it means and
 * who it names, in one place, rather than in each reader.
 */

/**
 * Why an item needs nothing from anybody, when it needs nothing.
 *
 * `nextAction` returning `null` used to mean five different things at once, and the difference
 * between them is the whole of what this vocabulary exists to say. An item waiting for a
 * dependency to ship is healthy; an item whose failing gate produced no action at all is the
 * defect GY-103 sat in for hours with nobody told. So every place that computes "nothing" now
 * says which nothing it is, and the one case that is none of them is named a defect rather than
 * left as silence:
 *
 * - `dependency` — another item's action moves this one. Its key is on `on`.
 * - `session` — a live session is already doing exactly what the gate waits for.
 * - `human` — one of the three decisions the project reserves for a person (AGENTS.md).
 * - `settled` — no gate refuses: the item is delivered, or merged and awaiting its record.
 * - `window` — the observation the item owes cannot exist before its recorded instant
 *   (`observationWindow.notBefore`, GY-1698); the loop dispatches it once the instant passes. On
 *   the loop (`on: 'loop'`, GY-1779) it is the loop's own reading, recorded in its
 *   deployment-verification step, never a dispatch.
 */
const waitKinds = ['dependency', 'session', 'human', 'settled', 'window'] as const;
type WaitKind = typeof waitKinds[number];
export interface ActionWait {
  kind: WaitKind;
  /** Who moves it: an item key, the session owner holding it, the operator; null when nobody is named. */
  on: string | null;
  detail: string;
}

/**
 * The complete answer for one item: the action it needs, or the named wait that says why it needs
 * none — and, when neither could be produced, the defect that says so.
 *
 * `defect` is the field this work item exists for. It is never set by a rule anybody wrote for a
 * situation; it is what is left when every rule has run and named nothing, which is exactly the
 * state no reader could previously distinguish from a healthy idle item. Nothing synthesises an
 * action to paper over it: naming an action no executor can complete is the failure mode the
 * mapping already guards against everywhere else (see `reviewStandstill` in
 * `next-action.ts`). It is reported instead — by `master status`, by the coordination loop's
 * actionable inventory, and by the dashboard.
 */
export interface ActionAccount {
  work: string; key: string;
  /** The failing gate this account answers and the refusal of it that was acted on; null when none refuses. */
  gate: string | null; refusal: string | null;
  action: NextAction | null;
  wait: ActionWait | null;
  defect: string | null;
  /** When the item entered the step its failing gate belongs to, and how long ago that was. */
  heldSince: string; heldMs: number;
}

