import { stableJson } from './stable-json.js';
import type { Work } from './work.js';

/**
 * What a GitHub observation of an item is derived from (GY-1310): the GitHub adapter's `observe`
 * reads the submission and the workspace it names, the candidate and last observation it compares
 * against, the policy and rework request, the base refresh that
 * holds a base, and whether the item is done. Everything else the
 * observation's save applies to the item as it stands when saved, and re-evaluates the gates on.
 */
function observationInputs(work: Work) {
  return stableJson({
    submission: work.submission ?? null, workspaces: work.workspaces, candidate: work.candidate ?? null, observation: work.observation ?? null,
    policy: work.policy, policyRevision: work.policyRevision,
    reworkRequested: work.reworkRequested ?? null, baseRefresh: work.baseRefresh ?? null, done: work.stage === 'done',
  });
}
/**
 * Whether an observation read from the item at one revision still stands on the item at a later
 * one (GY-1310): nothing the observation was derived from moved. A save that only moved what the
 * observation never read — a session, an escalation, a lease renewal, a dispatch, an evidence or
 * proof record — no longer discards the poll that observed the
 * change, so a gate claim waiting on an observation newer than itself is answered by that poll.
 * A resubmission, a new candidate, another observation saved first, a policy or
 * workspace change still refuses it: the observation was taken of something that is no longer the item.
 */
export function sameObservationInputs(read: Work, current: Work): boolean {
  return observationInputs(read) === observationInputs(current);
}
