import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { compactLedger, ledgerCompactedKind } from '../src/store/compaction.js';

/**
 * GY-4080: the events table kept growing at 94.7% of its bound. github.observed, github.queue,
 * heartbeat and merge-writer.trial-step rows older than 7 days go in compaction's small batches;
 * an item's history kinds, and the rows an item's documents still need, stay. Each run's removed
 * rows and bytes per kind are recorded for /healthz and master status.
 */
const routine = ['github.observed', 'github.queue', 'heartbeat', 'merge-writer.trial-step'];
const history = ['stage', 'claim', 'review.verdict.recorded', 'merge.trial-step'];

test('integration:events-routine-kinds-bounded — compaction removes only routine rows older than 7 days, keeps every history row and every newer row, and records the run', async t => {
  const store = await withDatabase('events-routine-kinds-bounded');
  t.after(() => store.close());
  await store.init();
  const id = randomUUID();
  const now = new Date().toISOString();
  const work = { id, key: 'GY-R1', title: 'Routine kinds', type: 'feature', priority: 3, stage: 'build', ready: true, revision: 1, createdAt: now, updatedAt: now,
    epoch: 1, lease: null, submission: null, workspaces: [], dependencies: [], evidence: [], criteria: [], actionQueue: { actions: [] }, gates: [] };
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1,$2)', [id, JSON.stringify(work)]);
  // Each row at `daysAgo`: a whole row carries the item's document, a delta row what changed since the last whole row (as `save` writes them).
  let base = 0;
  const row = async (kind: string, daysAgo: number, whole: boolean) => {
    work.revision++;
    const payload = whole ? { work: { ...work, pad: 'x'.repeat(2_000) } }
      : { stage: work.stage, delta: { base, revision: work.revision, updatedAt: now, lease: null, submission: null, ops: [[['pad'], 'y'.repeat(500)]] } };
    const seq = Number((await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES($1,'fixture',$2,$3, now() - ($4::text || ' days')::interval) RETURNING seq`,
      [id, kind, JSON.stringify(payload), String(daysAgo)])).rows[0].seq);
    if (whole) base = seq;
  };
  await row('create', 30, true);
  for (const kind of routine) { await row(kind, 9, true); await row(kind, 9, false); }
  for (const kind of history) await row(kind, 9, true);
  for (const kind of routine) { await row(kind, 1, true); await row(kind, 1, false); }
  for (const kind of history) await row(kind, 1, true);
  await row('requirements', 0, true);
  const rows = async () => (await store.pool.query(`SELECT kind, created_at < now() - interval '7 days' AS old FROM events WHERE work_id=$1 ORDER BY seq`, [id])).rows as { kind: string; old: boolean }[];
  const before = await rows();

  const result = await compactLedger(store.pool, { batch: 5, batches: 100, pauseMs: 0 });

  const after = await rows();
  const oldRoutine = (list: { kind: string; old: boolean }[]) => list.filter(r => r.old && routine.includes(r.kind)).map(r => r.kind);
  assert.deepEqual(oldRoutine(after), [], 'every routine row older than 7 days is gone');
  assert.deepEqual(after, before.filter(r => !(r.old && routine.includes(r.kind))), 'every other row stays: history kinds, the creation, and routine rows inside 7 days');
  for (const kind of routine) assert.equal(result.removed[kind], 2, `${kind}: its old whole and delta rows`);

  // Small batches outside any coordination transaction, each audited with rows and bytes per kind.
  const audits = (await store.pool.query('SELECT payload FROM events WHERE kind=$1', [ledgerCompactedKind])).rows.map(r => r.payload.details);
  assert.ok(audits.length > 1 && audits.every(a => a.total <= 5), 'each batch removes at most its batch size');
  assert.equal(audits.reduce((sum, a) => sum + a.total, 0), 8);
  assert.ok(audits.every(a => a.bytes > 0), 'each audit records the bytes it removed');

  // The run /healthz and master status show: rows and bytes removed per kind.
  const { lastCompaction, compactionLine } = await import('../src/store/compaction.js') as any;
  const run = lastCompaction();
  assert.equal(run.rows, 8);
  for (const kind of routine) assert.ok(run.removed[kind].rows === 2 && run.removed[kind].bytes > 0, `${kind} rows and bytes`);
  assert.equal(run.bytes, Object.values(run.removed as Record<string, { bytes: number }>).reduce((sum, k) => sum + k.bytes, 0));
  assert.match(compactionLine(run, Date.parse(run.at)), /^Compaction ran 0 min ago: removed 8 rows, [\d.]+ (KB|MB|GB)/);
});
