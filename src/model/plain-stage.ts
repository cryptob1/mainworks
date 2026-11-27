import type { Work } from './work.js';
import type { ServeCheck } from '../serve-app.js';
import { noRelease, servedFor, type ReleaseView } from './release.js';
import { parkedOnHuman } from './human-request.js';
import { humanAsk } from './human-ask.js';
import { reworkCapHeld, reworkCapLabel } from './rework-ground.js';

/**
 * Plain words for an item's derived stage (GY-2988). The control plane still derives
 * backlog/ready/build/review/test/acceptance/merge/done; only the words people read change.
 * One label per stage, never set by a client.
 */
export const plainStages = [
  'Not started', 'Waiting', 'Building', 'Testing', 'In review', 'Merging',
  'Merged, not live yet', 'Live', 'Live and verified', 'Live and failing', 'Done',
] as const;
export type PlainStage = typeof plainStages[number];

/** Whether the repository serves, the commit it serves, and GY-2983's verdict on that commit. */
export interface ServeView { serves: boolean; commit: string | null; check: ServeCheck | null }
export const noServe: ServeView = { serves: false, commit: null, check: null };

/** The serve view from the status read every page already has (`serving`). */
export function serveView(status: any): ServeView {
  const serving = status?.serving, serve = serving?.serve;
  if (!serve || typeof serve !== 'object') return noServe;
  const raw = serve.check;
  const check = raw && typeof raw === 'object' && typeof raw.verified === 'boolean'
    ? { verified: raw.verified, case: typeof raw.case === 'string' ? raw.case : null, step: typeof raw.step === 'string' ? raw.step : null, reason: typeof raw.reason === 'string' ? raw.reason : null }
    : null;
  return { serves: true, commit: typeof serving.commit === 'string' ? serving.commit : null, check };
}

/** Whether anyone is building it: a live lease or a running session (GY-3095). An item at build with neither is waiting. */
const building = (work: Work, now: number) =>
  (!!work.lease && Date.parse(work.lease.expiresAt) > now) || (work.sessions ?? []).some(session => session.state === 'running');

/**
 * Why an item at build waits, when it is known: its blocker, else its launch's last failure, else the launch it waits for.
 */
export function waitingReason(work: Work): string | null {
  // GY-3503: a parked item waits on its request, never on a launch.
  if (parkedOnHuman(work)) return `waits on a human: ${humanAsk(work.humanRequest!)}`;
  if (work.blocker) return work.blocker;
  if (reworkCapHeld(work)) return reworkCapLabel(work);
  const dispatch = work.actionQueue?.actions.find(action => action.kind === 'dispatch');
  if (!dispatch) return null;
  const failed = dispatch.history.findLast(record => record.event === 'failed');
  return failed ? `its last launch failed: ${failed.reason}` : `a launch is requested: ${dispatch.reason}`;
}

/** The wait a dashboard shows: a recorded blocker is pointed at, never repeated, since the item page shows it once (GY-1739). */
export const waitingLabel = (work: Work) => work.blocker ? 'held by its recorded blocker' : waitingReason(work);

/** The stage label a page shows: the plain stage, and for Waiting its reason when known (GY-3095). The caller supplies the clock. */
export function stageLabel(work: Work, now: number, release: ReleaseView = noRelease, serve: ServeView = noServe): string {
  const plain = plainStage(work, now, release, serve), reason = plain === 'Waiting' ? waitingLabel(work) : null;
  return reason ? `Waiting: ${reason}` : plain;
}

/**
 * The plain label for an item's derived stage. Derivation is unchanged; `release` and `serve`
 * only refine a delivered item. A verdict on the served commit names an item only when that
 * commit is the item's own merge, or the failing case is one of the item's proofs.
 */
export function plainStage(work: Work, now: number, release: ReleaseView = noRelease, serve: ServeView = noServe): PlainStage {
  switch (work.stage) {
    case 'backlog': case 'ready': return 'Not started';
    case 'build': return building(work, now) ? 'Building' : 'Waiting';
    case 'test': case 'acceptance': return 'Testing';
    case 'review': return 'In review';
    case 'merge': return 'Merging';
  }
  if (work.closure || !work.delivery) return 'Done';
  // A repository with no deployment (no serve, no watched release) has nothing further to reach.
  if (servedFor(work, release) === null) return serve.serves || release.observedAt !== null ? 'Merged, not live yet' : 'Done';
  const check = serve.check;
  if (!check) return 'Live';
  const own = !!serve.commit && serve.commit === work.delivery.mergeSha;
  if (check.verified) return own ? 'Live and verified' : 'Live';
  const proves = !!check.case && work.criteria.some(criterion => criterion.proofs.includes(`e2e:${check.case}`));
  return own || proves ? 'Live and failing' : 'Live';
}
