import { actionJudgment, type NextAction } from './action-kinds.js';
import { isFilingRefusal } from './user-facing.js';

/**
 * What an action nobody may run is waiting for (GY-104). `attention` and `request-rework` are
 * judgments made in the step itself (`actionJudgment`), so the executor holds no handler for
 * either: such a row is never claimed and never fails. It is recorded with the computed action,
 * so every reader — the dashboard, `master status`, the loop, the API — sees who owes it.
 */

/** Why an action leaves the executor loop, and the one command that answers it. */
export interface HumanNeeded { decision: string; resolve: string }
/** The computed action as this module writes it; `Work['nextAction']` is typed as the base kind. */
export interface OpenAction extends NextAction { needsHuman?: HumanNeeded }

/**
 * What an action waits on when no executor may run it, or null when the loop can run it itself.
 *
 * `actionJudgment` already says which kinds are judgments made in the step rather than inside a
 * session the step starts, and the executor refuses to hold a handler for one. That refusal is
 * only half the rule: a row nobody may claim also has to be owed by somebody, or the item sits
 * with an action that never runs and nobody was told. This names who owes it, and with which
 * command.
 */
export function humanNeeded(action: NextAction): HumanNeeded | null {
  if (actionJudgment[action.kind] !== 'in-step') return null;
  // A rework the loop owes is applied by the loop itself (GY-1387, GY-2874); the hand command is the fallback.
  if (action.kind === 'request-rework') return { decision: `a new head for ${action.key}`, resolve: `mainworks master rework ${action.key} REASON` };
  // GY-2981: a filing refusal the ready gate raised is answered by requirements, which adds the
  // criterion the item's creation rules now demand — it never weakens the item to fit them.
  if (action.inputs.kind === 'attention' && isFilingRefusal(action.inputs.detail))
    return { decision: `filing ${action.key} under today's rules`, resolve: `mainworks master requirements ${action.key} FILE REASON` };
  // A gate refusing something no executor step answers — an exhausted reviewer roster, an
  // unverified branch protection — names what has to be decided in the refusal itself.
  const detail = action.inputs.kind === 'attention' ? action.inputs.detail : action.reason;
  return { decision: `resolving ${action.key}'s refusal`, resolve: `mainworks diagnose ${action.key} — ${detail}` };
}

/** The step an item needs, with who owes it when no executor may run it. */
export function carriedAction(action: NextAction | null): OpenAction | null {
  if (!action) return null;
  const owed = humanNeeded(action);
  return { ...action, ...(owed ? { needsHuman: owed } : {}) };
}
