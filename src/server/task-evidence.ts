// Concern: GY-3599 — what the Task page reads beyond the item itself: where its merge trial's time
// went, folded from the merge ledger's own rows, and its changed files and their diffs, read from
// the control plane's checkout. Nothing here is stored.
import { demand } from '../model.js';
import type { Work } from '../model.js';
import { mergeLedgerKinds, mergeTrialKind, mergeTrialStepKind } from '../model/merge-ledger.js';
import { trialTimings, type TrialTimings } from '../model/task-evidence.js';
import { workIdByRef } from '../store/locked-read.js';
import { checkoutRoot } from '../merge-writer/local-observation.js';
import { gitRunner } from './merge-record.js';
import type { Services } from './routes.js';

/** `GET /api/work/ID/timings`: when the item was released, its newest merge trial's timings, and the install's checkout a head is checked out in. */
export async function readTaskTimings(services: Services, id: string): Promise<{ releasedAt: string | null; trial: TrialTimings | null; checkout: string }> {
  const pool = services.engine.store.pool;
  const read = await pool.query(`SELECT kind, payload, created_at, clock_timestamp() AS now FROM events WHERE work_id = ${workIdByRef('$1')} AND kind = ANY($2::text[]) ORDER BY seq`,
    [id, ['ready', mergeLedgerKinds.intent, mergeTrialStepKind, mergeTrialKind]]);
  const released = read.rows.find(row => row.kind === 'ready');
  return { releasedAt: released ? new Date(released.created_at).toISOString() : null, trial: trialTimings(read.rows, read.rows[0] ? new Date(read.rows[0].now).getTime() : Date.now()), checkout: checkoutRoot() };
}

/** How much of one file's diff the page is sent. */
const diffLimit = 200_000;
/** `GET /api/work/ID/diff`: the submitted head's changed files with their line counts; with `?path=`, that file's diff. */
export async function readTaskDiff(services: Services, id: string, path: string | null) {
  const work = (await services.engine.store.pool.query(`SELECT document FROM work_items WHERE id = ${workIdByRef('$1')}`, [id])).rows[0]?.document as Work | undefined;
  demand(work, 'Work item not found', 404);
  if (!work.candidate) return path === null ? { files: [] } : { diff: '' };
  const range = `${work.observation?.mergeBase ?? work.candidate.baseSha}...${work.candidate.sha}`;
  const git = async (args: string[]) => { const result = await gitRunner(services.engine)(args); demand(result.status === 0, 'This change is not in the control plane\'s checkout yet', 404); return result.stdout; };
  // Names come unquoted (`-z`) and reach git as the literal path they are, never as a pattern a `[`, `*` or `?` in a name would make of them.
  if (path !== null) { const diff = await git(['--literal-pathspecs', 'diff', range, '--', path]); return { diff: diff.slice(Math.max(0, diff.indexOf('\n@@') + 1), diffLimit) }; }
  return { files: (await git(['diff', '--numstat', '-z', '--no-renames', range])).split('\0').filter(Boolean).map(entry => { const [additions, deletions, name] = entry.split('\t'); return { path: name ?? '', additions: Number(additions) || 0, deletions: Number(deletions) || 0 }; }) };
}
