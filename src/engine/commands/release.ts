import { record } from '../../store/mutations.js';
import { wakeJob } from '../../store.js';
import { activeLease } from '../../model.js';
import { submittedBranchMoved } from '../../model/assignment.js';
import { endAttempt } from '../../pipeline-speed.js';
import type { Ctx } from './types.js';
import { endedBySubmission } from '../leases.js';

export async function run(c: Ctx) {
  const { db, actor, data, now, work } = c;
  endedBySubmission(work, data.epoch);
  activeLease(work, actor, data.epoch, now);
  if (data.failure) await record(db, work, actor.id, 'workspace.failed', { details: { epoch: data.epoch, message: data.failure.message, at: now.toISOString() } });
  // GY-1286: a rework workspace refused because the PR branch moved past the observed head can
  // only be built once that head is observed, so the release wakes the observation, prioritized.
  if (data.failure?.message.startsWith(submittedBranchMoved) && work.submission) await wakeJob(db, work.id, true);
  // GY-3905: a release always ends the attempt; its epoch is never reused, so a late command under it is refused.
  endAttempt(work, data.epoch, 'released', now, data.cause);
  work.lease = null;
}
