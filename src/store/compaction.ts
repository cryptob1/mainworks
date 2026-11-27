import type pg from 'pg';
import { advisoryLocks } from './locks.js';
import { routineSaveKinds } from './snapshot-delta.js';
import { DELIVERY_EVENT_PREDICATE } from './tables/production.js';
import { setting } from '../setting.js';

/**
 * Ledger compaction (GY-979): routine rows past their retention window are deleted, a bounded
 * batch at a time, with an audit row naming what went.
 *
 * The ledger is append-only history, but its routine kinds (`routineSaveKinds`: observations,
 * renewals, reconciliation passes, action-queue claims and failures, queue and session
 * bookkeeping) are the continuous writes no lifecycle reader looks back at, and they filled a
 * 19 GB volume in production. A row is removed only when every one of these holds:
 * - its kind is routine — the events trigger itself refuses any other kind, and any delete not
 *   made under this module's transaction setting (`graphyard.ledger_compaction`);
 * - it is older than the retention window, and it is not
 *   its item's newest save (the ledger's copy of the current document);
 * - it is no delta's base: a delta row is never one, and a whole row goes only when a newer whole
 *   row of its item exists (so no save can still take it as a base) and no delta names it;
 * - a whole row repeats the stage and delivery of the item's previous whole row, so every stage
 *   timeline (the intervention report's "stage before") reads the same;
 * - it is not a delivery event (`DELIVERY_EVENT_PREDICATE`), nor the revision an item's delivery
 *   cites as its authorization, nor a row of an item observed
 *   merged but not yet done (its merge is still judged against the record before it).
 * Every surviving row therefore resolves to exactly the document it resolved to before.
 * Executor bookkeeping rows (`bookkeepingKinds`, no work item, records kept in `loop_state`) older
 * than the window go whole (GY-3342). Every other row is kept.
 *
 * A batch reads a window of the ledger in seq order from a saved cursor (GY-3111), never the whole
 * ledger ordered by age: each finishes well inside the statement timeout, and a run keeps the
 * progress of every batch it committed.
 */
export const ledgerRetentionMs = 14 * 24 * 60 * 60 * 1000;
/** The retention window: `GRAPHYARD_LEDGER_RETENTION_DAYS` (at least one day), else `ledgerRetentionMs`. */
export function configuredLedgerRetentionMs(env: NodeJS.ProcessEnv = process.env) {
  const days = Number(setting('LEDGER_RETENTION_DAYS', env));
  return Number.isFinite(days) && days >= 1 ? Math.floor(days * 24 * 60 * 60 * 1000) : ledgerRetentionMs;
}
/** Ledger rows one batch reads (and so deletes at most); each batch is its own short transaction. */
export const ledgerCompactionBatch = 2_000;
/** Batches one run takes at most; the saved cursor carries a pass across runs. */
const ledgerCompactionBatches = 20;
/** How often the server's reconciliation tick runs a compaction. */
export const ledgerCompactionIntervalMs = 10 * 60_000;
/** The audit row each batch that removed anything appends (never itself compacted: not a routine kind). */
export const ledgerCompactedKind = 'ledger.compacted';

/**
 * GY-3342: executor bookkeeping rows (no work item). The records themselves live in `loop_state`;
 * the ledger row only names which ids changed, and goes whole once past the retention window.
 */
const bookkeepingKinds = ['loop-state.saved', 'loop-state.migrated'] as const;
/** Pause between batches, so a pass never holds the database for more than one short batch at a time. */
const ledgerCompactionPauseMs = 100;

/**
 * GY-4005: the high-volume install-wide kinds nothing reads past a day: registry observations and
 * session ends, each of which carried the whole registry document (about 100 KB) before the registry
 * kept its document in its own row. Rows older than `expiringRetentionMs` go whole. They carry no
 * work item, so none is an item's history; stage, verdict, merge, lease and receipt rows never match.
 */
export const expiringKinds = ['agent-registry.observed', 'agent-registry.session-ended', 'agent-registry.sessions-settled'] as const;
export const expiringRetentionMs = 7 * 24 * 60 * 60 * 1000;
/** Rows one retention batch deletes at most; each batch is its own short transaction. */
const expiringBatch = 1_000;
/** A catch-up that removed at least this many rows rewrites the table once it is done, so its size drops. */
const rewriteAfterRows = 50_000;

const literal = (list: readonly string[]) => `ARRAY[${list.map(kind => `'${kind}'`).join(',')}]::text[]`;
const kinds = literal([...routineSaveKinds, ...bookkeepingKinds, ...expiringKinds]);

/**
 * The events table's own immutability trigger: every UPDATE is refused, and every DELETE unless it
 * is of a routine kind inside a compaction transaction. Installed with the events DDL in place of
 * the shared `graphyard_immutable` trigger.
 */
export const eventsImmutableDdl = `CREATE OR REPLACE FUNCTION graphyard_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('graphyard.ledger_compaction', true) = 'on' AND OLD.kind = ANY(${kinds}) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'The event ledger is append-only';
END $$;
DROP TRIGGER IF EXISTS immutable_events ON events;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION graphyard_events_immutable();`;

// $1 routine kinds, $2 cutoff, $3 window start (exclusive), $4 window end (inclusive): a batch reads only
// the rows of its own seq window. The items in the window are taken once, with the revision each one's
// delivery cites (its first delivery event, through events_work_delivery; a delivery is never
// rewritten); an item observed merged but not yet done is left out whole.
const items = `WITH items AS MATERIALIZED (SELECT w.work_id, (SELECT x.payload->'work'->'delivery'->>'authorizationRevision' FROM events x
      WHERE x.work_id = w.work_id AND ${DELIVERY_EVENT_PREDICATE} ORDER BY x.seq LIMIT 1) AS cited
    FROM (SELECT DISTINCT work_id FROM events WHERE seq > $3 AND seq <= $4 AND work_id IS NOT NULL) w JOIN work_index i ON i.id = w.work_id
    WHERE NOT COALESCE(i.pr_state = 'merged' AND i.stage IS DISTINCT FROM 'done', false))`;
// `revision` is the revision the candidate row stands for.
const scope = (revision: string) => `e.seq > $3 AND e.seq <= $4 AND e.kind = ANY($1::text[]) AND e.created_at < $2 AND c.cited IS DISTINCT FROM ${revision}`;
/** Delta and document-less routine rows: never a base. The item's newest save, its current document, stays. */
const loose = `SELECT e.seq FROM events e JOIN items c ON c.work_id = e.work_id
  WHERE ${scope("e.payload->'delta'->>'revision'")} AND NOT (e.payload ? 'work')
    AND EXISTS (SELECT 1 FROM events n WHERE n.work_id = e.work_id AND n.seq > e.seq AND (n.payload ? 'work' OR n.payload ? 'delta'))`;
/** Whole routine rows that no save or delta can still need, repeating the previous whole row's stage and delivery. */
const whole = `SELECT e.seq FROM events e JOIN items c ON c.work_id = e.work_id
  CROSS JOIN LATERAL (SELECT n.seq FROM events n WHERE n.work_id = e.work_id AND n.seq > e.seq AND n.payload ? 'work' ORDER BY n.seq LIMIT 1) nxt
  CROSS JOIN LATERAL (SELECT p.payload->'work'->'stage' AS stage, p.payload->'work'->'delivery' AS delivery FROM events p
    WHERE p.work_id = e.work_id AND p.seq < e.seq AND p.payload ? 'work' ORDER BY p.seq DESC LIMIT 1) prev
  WHERE ${scope("e.payload->'work'->>'revision'")} AND e.payload ? 'work'
    AND prev.stage IS NOT DISTINCT FROM e.payload->'work'->'stage' AND prev.delivery IS NOT DISTINCT FROM e.payload->'work'->'delivery'
    AND NOT EXISTS (SELECT 1 FROM events d WHERE d.work_id = e.work_id AND d.payload ? 'delta' AND d.payload->'delta'->>'base' = e.seq::text AND d.seq > e.seq AND d.seq < nxt.seq)
    AND NOT EXISTS (SELECT 1 FROM events x WHERE x.seq = e.seq AND ${DELIVERY_EVENT_PREDICATE})`;
/** Bookkeeping rows past the window: they cite no item, and their records live in `loop_state`. */
const bookkeeping = `SELECT seq FROM events WHERE seq > $3 AND seq <= $4 AND work_id IS NULL AND kind = ANY(${literal(bookkeepingKinds)}) AND created_at < $2`;
/**
 * A batch's candidate reads, in order: loose rows first, so a whole row whose deltas just went is
 * judged without them. Each picks seqs inside the window; the delete then goes by primary key alone,
 * never a semi-join the planner may answer with a scan of the whole ledger.
 */
export const candidateSql = [`${items} ${loose} UNION ALL ${bookkeeping}`, `${items} ${whole}`];

export interface LedgerCompaction { removed: Record<string, number>; total: number; batches: number; cutoff: string; cursor: number; skipped?: 'busy' }

/**
 * Compact routine rows older than `retentionMs`: at most `batches` batches, each reading the next
 * `batch` ledger rows past the saved cursor (`ledger_compaction_cursor`). Each batch is one short
 * transaction that deletes what may go in its window, appends one `ledger.compacted` audit row with
 * the counts per kind when it removed anything, and saves the cursor at the window's end, so a run
 * resumes where the last stopped. Past the newest row old enough to compact, the cursor returns to
 * the start for the next pass. Runs on the pool, outside the coordination lock: a save only ever
 * extends its item's newest whole row, which is never removed.
 */
export async function compactLedger(pool: pg.Pool, options: { retentionMs?: number; batch?: number; batches?: number; actor?: string; pauseMs?: number } = {}): Promise<LedgerCompaction> {
  const retentionMs = Math.max(0, Math.floor(options.retentionMs ?? ledgerRetentionMs));
  const batch = Math.max(1, Math.floor(options.batch ?? ledgerCompactionBatch)), batches = Math.max(1, Math.floor(options.batches ?? ledgerCompactionBatches));
  const removed: Record<string, number> = {};
  let total = 0, ran = 0, cutoff = new Date(Date.now() - retentionMs), upper: string | null = null, cursor = '0', measured = false;
  for (; ran < batches; ran++) {
    const db = await pool.connect();
    let end: string | null = null, byKind: Record<string, number> = {};
    try {
      await db.query('BEGIN');
      if (!(await db.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [advisoryLocks.ledgerCompaction])).rows[0].ok) {
        await db.query('ROLLBACK');
        return { removed, total, batches: ran, cutoff: cutoff.toISOString(), cursor: Number(cursor), skipped: 'busy' };
      }
      // One cutoff for the whole run, on the database clock the rows were stamped with, and the newest row it reaches.
      if (!measured) {
        measured = true;
        cutoff = (await db.query(`SELECT clock_timestamp() - ($1::text||' milliseconds')::interval AS cutoff`, [String(retentionMs)])).rows[0].cutoff;
        // The newest old row by two probes of the created_at index, never a sort of every old row.
        upper = (await db.query('SELECT max(seq) AS seq FROM events WHERE created_at = (SELECT max(created_at) FROM events WHERE created_at < $1)', [cutoff])).rows[0]?.seq ?? '0';
        cursor = (await db.query('SELECT seq FROM ledger_compaction_cursor')).rows[0]?.seq ?? '0';
      }
      end = (await db.query('SELECT max(seq) AS seq FROM (SELECT seq FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3) w', [cursor, upper, batch])).rows[0].seq;
      await db.query("SET LOCAL graphyard.ledger_compaction = 'on'");
      const rows: { seq: string; kind: string }[] = [];
      for (const sql of end === null ? [] : candidateSql) {
        const seqs = (await db.query(sql, [[...routineSaveKinds], cutoff, cursor, end])).rows.map(row => row.seq as string);
        if (seqs.length) rows.push(...(await db.query('DELETE FROM events WHERE seq = ANY($1::bigint[]) RETURNING seq, kind', [seqs])).rows);
      }
      for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      if (rows.length) {
        const seqs = rows.map(row => Number(row.seq));
        await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [options.actor ?? 'graphyard', ledgerCompactedKind,
          JSON.stringify({ details: { removed: byKind, total: rows.length, cutoff: cutoff.toISOString(), retentionMs, firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) } })]);
      }
      await db.query('INSERT INTO ledger_compaction_cursor(id,seq) VALUES(true,$1) ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq', [end ?? '0']);
      await db.query('COMMIT');
      cursor = end ?? '0';
      for (const [kind, n] of Object.entries(byKind)) removed[kind] = (removed[kind] ?? 0) + n;
      total += rows.length;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
    if (end === null) break;
    // The pause follows every batch that did work, the last of a run included, so a caller that
    // loops runs never reaches the next batch back to back across the seam between runs.
    await new Promise(resolve => setTimeout(resolve, options.pauseMs ?? ledgerCompactionPauseMs));
  }
  return { removed, total, batches: ran, cutoff: cutoff.toISOString(), cursor: Number(cursor) };
}

let expiredSinceRewrite = 0;
/**
 * GY-4005: delete rows of `expiringKinds` older than the window, at most `batch` rows per short
 * transaction on the pool (never under the coordination lock), each batch audited with a
 * `ledger.compacted` row. When a catch-up of many rows finishes, the events table is rewritten once
 * (VACUUM FULL, waiting at most 5 s for its lock) so its size drops instead of only its growth stopping;
 * a rewrite that fails (its lock busy, or too little disk for the copy) is not retried until the next catch-up.
 */
export async function expireEvents(pool: pg.Pool, options: { retentionMs?: number; batch?: number; batches?: number; pauseMs?: number; rewriteAfter?: number } = {}) {
  const retentionMs = options.retentionMs ?? expiringRetentionMs, batch = options.batch ?? expiringBatch;
  const removed: Record<string, number> = {};
  let total = 0, done = false;
  for (let ran = 0; ran < (options.batches ?? ledgerCompactionBatches) && !done; ran++) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL graphyard.ledger_compaction = 'on'");
      const rows = (await db.query(`DELETE FROM events WHERE seq = ANY(ARRAY(SELECT seq FROM events WHERE kind = ANY($1::text[]) AND work_id IS NULL
        AND created_at < clock_timestamp() - ($2::text||' milliseconds')::interval LIMIT $3)) RETURNING kind`, [[...expiringKinds], String(retentionMs), batch])).rows as { kind: string }[];
      const byKind: Record<string, number> = {};
      for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      if (rows.length) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', ledgerCompactedKind, JSON.stringify({ details: { removed: byKind, total: rows.length, retentionMs } })]);
      await db.query('COMMIT');
      for (const [kind, n] of Object.entries(byKind)) removed[kind] = (removed[kind] ?? 0) + n;
      total += rows.length; done = rows.length < batch;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
    if (!done) await new Promise(resolve => setTimeout(resolve, options.pauseMs ?? ledgerCompactionPauseMs));
  }
  expiredSinceRewrite += total;
  let rewritten = false;
  if (done && expiredSinceRewrite >= (options.rewriteAfter ?? rewriteAfterRows)) {
    const db = await pool.connect();
    let failed: Error | undefined;
    try {
      await db.query("SET statement_timeout = 0; SET lock_timeout = '5s'");
      await db.query('VACUUM (FULL, ANALYZE) events');
      rewritten = true;
    } catch (error) { failed = error as Error; console.error('events table rewrite failed', failed.message); } finally { expiredSinceRewrite = 0; db.release(failed ?? true); }
  }
  return { removed, total, done, rewritten };
}
