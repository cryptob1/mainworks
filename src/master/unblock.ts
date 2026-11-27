// Concern: `master unblock` clearing a blocker, retried when the item's revision moved under it.
import { randomUUID } from 'node:crypto';
import type { Work } from '../model.js';
import { answerCommand, parkedOnHuman } from '../model/human-request.js';
import { blockerAuthor, blockerSince } from '../model/work.js';
import { setting } from '../setting.js';

/** How many times `master unblock` writes before a stale-revision refusal is reported (GY-1103). */
export const unblockAttempts = 3;
/**
 * The Idempotency-Key of one write: a caller's GRAPHYARD_REQUEST_ID on the first, suffixed on each
 * retry since a retry binds a different revision; a fresh key when the caller names none.
 */
export const attemptKey = (attempt: number, request = setting('REQUEST_ID')) => request ? (attempt > 1 ? `${request}:unblock-${attempt}` : request) : randomUUID();
const staleRevision = (error: unknown) => error instanceof Error && /Task revision changed/.test(error.message);

/**
 * Clearing a blocker is idempotent intent, but an observation or heartbeat landing between the
 * read and the write moves the revision under it (GY-1103). A stale-revision refusal reloads the
 * item and writes again on the fresh revision while the same blocker stands, up to
 * `unblockAttempts` writes; a cleared or changed blocker is reported instead, since the intent
 * judged no longer matches the item. Any other refusal is reported at once.
 */
export async function unblockWithRetry<T>(work: Work, write: (work: Work, attempt: number) => Promise<T>, reload: (key: string) => Promise<Work>): Promise<T> {
  const judged = work.blocker;
  for (let attempt = 1; ; attempt++) {
    try { return await write(work, attempt); }
    catch (error) {
      if (attempt >= unblockAttempts || !staleRevision(error)) throw error;
      const fresh = await reload(work.key);
      if (!fresh.blocker) throw new Error(`${work.key} is no longer blocked at revision ${fresh.revision}; nothing was unblocked`);
      if (fresh.blocker !== judged) throw new Error(`${work.key}'s blocker changed at revision ${fresh.revision}, so it was not unblocked: was ${JSON.stringify(judged)}, now ${JSON.stringify(fresh.blocker)}`);
      work = fresh;
    }
  }
}

/**
 * GY-3996: one line printed after `master release` when the released item still carries an open
 * recorded blocker — its first 120 characters, who recorded it and when (each as the item records
 * it), and the command that clears it: the Lead's unblock, or the owner's answer while the item
 * waits on a human decision. Null when no blocker remains.
 */
export function remainingBlockerNotice(work: Pick<Work, 'key' | 'blocker' | 'blockedAt' | 'agentRequests' | 'capacity' | 'humanRequest' | 'humanRequests' | 'pipeline'> | null | undefined): string | null {
  if (!work?.blocker) return null;
  const text = work.blocker.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!text) return null;
  const who = blockerAuthor(work), since = blockerSince(work);
  const recorded = [who && `by ${who}`, work.blockedAt ? `at ${work.blockedAt}` : since !== null ? `at ${new Date(since).toISOString()}` : null].filter(Boolean).join(' ');
  const clear = parkedOnHuman(work) ? `the owner answers it with: ${answerCommand(work.key, work.humanRequest!)}` : `clear it with: mainworks master unblock ${work.key} REASON`;
  return `Note: ${work.key} still has an open blocker${recorded ? ` (recorded ${recorded})` : ''}: ${text} — ${clear}`;
}
