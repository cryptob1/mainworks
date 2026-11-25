// GY-3756: whether the update service (the deploy unit) runs the release this install serves, as
// the loop reads it from the unit's process each pass, and master status's one line when it does not.
import { storeAction, type DaemonState } from './state.js';

const deployReleaseKey = 'deploy-unit:release';
/** How long the update service may run another release than the served one before status says so. */
const deployReleaseGraceMs = 10 * 60_000;

/** Record the update service's release against the served one: `at` is when they first differed; equal, the record goes. */
export function noteDeployRelease(state: DaemonState, running: string | null, serving: string | null, now: number) {
  if (!running || !serving || running === serving) { delete state.actions[deployReleaseKey]; return; }
  const since = state.actions[deployReleaseKey]?.at ?? new Date(now).toISOString();
  storeAction(state, deployReleaseKey, { kind: 'attention', work: null, principal: null, state: 'failed', attempts: 1, epoch: null, cycle: state.cycle, at: since,
    detail: `The update service runs release ${running.slice(0, 12)}, not ${serving.slice(0, 12)} this install serves.` });
}

/** One attention line once the two have differed for more than 10 minutes. */
export function deployReleaseAttention(state: Pick<DaemonState, 'actions'> | null | undefined, now: number) {
  const entry = state?.actions[deployReleaseKey];
  if (entry?.state !== 'failed' || now - Date.parse(entry.at) <= deployReleaseGraceMs) return [];
  return [{ subject: 'update service', text: entry.detail, next: 'Nothing to run: the loop points the update service at the served release and restarts it; if this stays, the loop log names why' }];
}
