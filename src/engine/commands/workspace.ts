import { record } from '../../store/mutations.js';
import { pathsOverlap, validBranch } from '../../workspace.js';
import { activeLease, demand } from '../../model.js';
import type { Ctx } from './types.js';

export async function run(c: Ctx) {
  const { db, actor, data, all, now, work } = c;
  activeLease(work, actor, data.epoch, now);
  demand(validBranch(data.branch), 'Only a Mainworks branch can be reserved');
  demand(!work.workspaces.some(w => w.epoch === data.epoch), 'This assignment already has a workspace');
  // A rework reuses its own item's branch and, since GY-3632, its worktree path.
  demand(!all.some(w => (w.id !== work!.id || !work!.reworkRequested) && w.workspaces.some(s => s.branch === data.branch || s.host === data.host && pathsOverlap(s.path, data.path))), 'Branch or host/path is already reserved or overlaps a reservation; use a fresh workspace');
  // The linked branch is the submitted candidate's (GY-3582: the loop's resubmission records its
  // submission at an epoch no workspace stands at, keeping the blocked attempt's branch on the
  // candidate), falling back to the submission epoch's workspace.
  if (work.submission) demand(data.branch === (work.candidate?.branch ?? work.workspaces.find(w => w.epoch === work!.submission!.epoch)?.branch), 'Rework must use the already linked PR branch in a fresh workspace');
  const { preserved, ...workspace } = data;
  work.workspaces.push({ ...workspace, owner: actor.id });
  // The preserved-attempt record (GY-860): what the released holder of this branch carried —
  // its refs and uncommitted diff — is kept on the item's ledger, never discarded silently.
  if (data.preserved) await record(db, work, actor.id, 'workspace.preserved', { details: { epoch: data.epoch, branch: data.branch, ...data.preserved } });
}
