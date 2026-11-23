import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from './helpers/loop-state.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Work } from '../src/model.js';
import { readReviewLedger, saveReviewLedger, type ReviewRecord } from '../src/reviewer.js';
import { reviewLaunchAttention } from '../src/cli/master-status.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';

/**
 * GY-3729: a failed reviewer launch leaves its failure in the dispatch cursor, and master status
 * read it as "has no reviewer" while the next launch's session already ran on the same head.
 */
const head = 'a'.repeat(40), base = 'b'.repeat(40), older = 'c'.repeat(40);
const now = new Date().toISOString();
const requestId = randomUUID();
const item = { key: 'GY-40', stage: 'review', policyRevision: 1, reworkRequested: false, submission: { epoch: 1, pr: 40 },
  candidate: { sha: head, baseSha: base, pr: 40, branch: 'graphyard/gy-40-1', author: 'graphyard-claude-1' },
  autoDispatch: { review: { id: requestId, kind: 'review', sha: head, baseSha: base, policyRevision: 1, state: 'requested', requestedAt: now, attempts: 1 }, producers: [], history: [] } } as unknown as Work;
const record = (sha: string): ReviewRecord => ({ id: randomUUID(), key: item.key, pr: 40, sha, baseSha: base, policyRevision: 1, profile: 'cursor-reviewer', agentName: 'graphyard-cursor-reviewer',
  pane: null, sessionDirectory: '/tmp/session', requestedAt: now, tokenExpiresAt: now, requestId, attempt: 2, state: 'pending' });

test('integration:no-reviewer-alert-current — the no-reviewer line stays after a failed launch and clears once a reviewer runs on the current head', async () => {
  const root = await temporaryDirectory('no-reviewer-alert');
  const cursor = { ...emptyDispatchCursor({ url: 'https://graphyard.example', repository: 'owner/project' } as never), failures: { [requestId]: { kind: 'review' as const, work: item.key, sha: head, attempts: 1, reason: 'the claude-a launch failed', at: now, nextAt: now } } };
  const lines = async () => reviewLaunchAttention([item], cursor, Date.now(), (await readReviewLedger(root)).reviews).map(line => line.text);

  // A failed launch, and only a session on an older head: no reviewer runs on the current head.
  await saveReviewLedger(root, { version: 1, reviews: [record(older)] });
  assert.deepEqual(await lines(), [`GY-40's review of ${head.slice(0, 12)} has no reviewer: the claude-a launch failed`]);

  // The next launch runs a reviewer on the current head: the line goes.
  await saveReviewLedger(root, { version: 1, reviews: [record(older), record(head)] });
  assert.deepEqual(await lines(), [], 'a reviewer session is live on the current head');
});
