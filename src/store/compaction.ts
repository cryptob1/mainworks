import type pg from 'pg';
import type { Work } from '../model.js';
import { advisoryLocks } from './locks.js';
import { routineSaveKinds, workDiff } from './snapshot-delta.js';
import { DELIVERY_EVENT_PREDICATE } from './tables/production.js';
import { setting } from '../setting.js';

/**
 * Ledger compaction (GY-979, GY-4132): routine and bookkeeping rows past their retention window
 * are deleted directly by kind and age (`events_kind_created`), in short independent batches,
 * with an audit row naming what went.
 *
 * A row is removed only when every one of these holds:
 * - its kind is compactable — the events trigger itself refuses any other kind, and any delete
 *   not made under this module's transaction setting (`graphyard.ledger_compaction`);
 * - it is older than its kind's retention window, and it is not its item's newest save;
 * - if it is a whole save that later delta rows still reference, the earliest surviving delta is
 *   promoted to a whole save and any subsequent deltas on that base are re-based onto it, under
 *   a `FOR UPDATE SKIP LOCKED` lock on the item's `work_items` row so no concurrent save can
 *   extend a base being removed;
 * - a whole row repeats the stage and delivery of the item's previous whole row, so every stage
 *   timeline reads the same;
 * - it is not a delivery event (`DELIVERY_EVENT_PREDICATE`), nor the revision an item's delivery
 *   cites as its authorization, nor a row of an item observed merged but not yet done.
 * Every surviving row therefore resolves to exactly the document it resolved to before.
 * Executor bookkeeping rows (`bookkeepingKinds`, no work item, records kept in `loop_state`) older
 * than the window go whole (GY-3342). Every other row is kept.
 */
export const ledgerRetentionMs = 14 * 24 * 60 * 60 * 1000;
/** The retention window: `GRAPHYARD_LEDGER_RETENTION_DAYS` (at least one day), else `ledgerRetentionMs`. */
export function configuredLedgerRetentionMs(env: NodeJS.ProcessEnv = process.env) {
  const days = Number(setting('LEDGER_RETENTION_DAYS', env));
  return Number.isFinite(days) && days >= 1 ? Math.floor(days * 24 * 60 * 60 * 1000) : ledgerRetentionMs;
}
/** Ledger rows one batch reads (and so deletes at most); each batch is its own short transaction. */
export const ledgerCompactionBatch = 2_000;
/** Time budget for one compaction pass; the next pass continues if expired rows remain. */
const ledgerCompactionBudgetMs = 60_000;
/** Batches `expireEvents` takes at most per call when no override is given. */
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
/**
 * GY-4080: the item kinds written most, compacted after `expiringRetentionMs` instead of the ledger window,
 * under every rule above (never an item's newest save, a stage change or a delivery). Their readers:
 * github.observed and heartbeat are read only through the item's resolved document (its newest save) and
 * the delivery predicate (`DELIVERY_EVENT_PREDICATE`, kept); the stall alarm (daemon/stall-alarm.ts) reads
 * only recent rows. github.queue has no writer or reader left in src. merge-writer.trial-step is read by no
 * src query; the trial's step itself is `merge.trial-step`, which the merge ledger folds, and is kept.
 */
export const boundedKinds = ['github.observed', 'github.queue', 'heartbeat', 'merge-writer.trial-step'] as const;
const boundedSet = new Set<string>(boundedKinds);
const routineOnlyKinds = routineSaveKinds.filter(kind => !boundedSet.has(kind));
/** Rows one retention batch deletes at most; each batch is its own short transaction. */
const expiringBatch = 1_000;
/**
 * A catch-up that freed at least this many stored payload bytes rewrites the table once it is done, so
 * its size drops. Rows written since the registry stopped carrying its document are small, so only the
 * first catch-up of the old whole-document rows reaches it.
 */
const rewriteAfterBytes = 1e9;

const literal = (list: readonly string[]) => `ARRAY[${list.map(kind => `'${kind}'`).join(',')}]::text[]`;
const kinds = literal([...new Set([...routineSaveKinds, ...bookkeepingKinds, ...expiringKinds, ...boundedKinds])]);

/**
 * The events table's own immutability trigger: every DELETE is refused unless it is of a compactable
 * kind inside a compaction transaction, and every UPDATE is refused unless compaction is rewriting a
 * delta row's payload (promoting it to whole or re-basing it onto a newer whole save) without changing
 * its identity or timestamp. Installed with the events DDL in place of `graphyard_immutable`.
 */
export const eventsImmutableDdl = `CREATE OR REPLACE FUNCTION graphyard_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('graphyard.ledger_compaction', true) = 'on' AND OLD.kind = ANY(${kinds}) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND current_setting('graphyard.ledger_compaction', true) = 'on'
    AND NEW.seq = OLD.seq AND NEW.work_id IS NOT DISTINCT FROM OLD.work_id AND NEW.actor = OLD.actor AND NEW.kind = OLD.kind AND NEW.created_at = OLD.created_at
    AND OLD.payload ? 'delta' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'The event ledger is append-only';
END $$;
DROP TRIGGER IF EXISTS immutable_events ON events;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION graphyard_events_immutable();`;

/**
 * First batch lookup for expired rows of one compactable kind, indexed by `events_kind_created(kind, created_at)`.
 * $1 kind, $2 cutoff, $3 limit.
 */
export const batchLookupSql = `SELECT seq, work_id, created_at::text AS created_at_text FROM events
  WHERE kind = $1 AND created_at < $2 ORDER BY created_at LIMIT $3`;
/**
 * Subsequent batch lookup for the same kind in one pass, advancing past rows that stayed.
 * $1 kind, $2 cutoff, $3 afterCreatedAt (text), $4 keptAtSame (bigint[]), $5 limit.
 */
const batchLookupNextSql = `SELECT seq, work_id, created_at::text AS created_at_text FROM events
  WHERE kind = $1 AND created_at >= $3::timestamptz AND created_at < $2
    AND (created_at > $3::timestamptz OR seq <> ALL($4::bigint[]))
  ORDER BY created_at LIMIT $5`;

// Per-batch candidate evaluation operating strictly on the batch's primary keys ($1::bigint[]).
const batchItems = `WITH items AS MATERIALIZED (SELECT w.work_id, (SELECT x.payload->'work'->'delivery'->>'authorizationRevision' FROM events x
      WHERE x.work_id = w.work_id AND ${DELIVERY_EVENT_PREDICATE} ORDER BY x.seq LIMIT 1) AS cited
    FROM (SELECT DISTINCT work_id FROM events WHERE seq = ANY($1::bigint[]) AND work_id IS NOT NULL) w JOIN work_index i ON i.id = w.work_id
    WHERE NOT COALESCE(i.pr_state = 'merged' AND i.stage IS DISTINCT FROM 'done', false))`;

/** Loose (delta or document-less) rows in the batch that may be deleted immediately. */
const batchLooseSql = `${batchItems}
  SELECT e.seq FROM events e JOIN items c ON c.work_id = e.work_id
  WHERE e.seq = ANY($1::bigint[]) AND NOT (e.payload ? 'work')
    AND c.cited IS DISTINCT FROM (e.payload->'delta'->>'revision')
    AND EXISTS (SELECT 1 FROM events n WHERE n.work_id = e.work_id AND n.seq > e.seq AND (n.payload ? 'work' OR n.payload ? 'delta'))
  UNION ALL
  SELECT seq FROM events WHERE seq = ANY($1::bigint[]) AND work_id IS NULL`;

/** Whole rows in the batch eligible for deletion once any surviving deltas on them are moved forward. */
const batchWholeSql = `${batchItems}
  SELECT e.seq, e.work_id FROM events e JOIN items c ON c.work_id = e.work_id
  CROSS JOIN LATERAL (SELECT p.payload->'work'->'stage' AS stage, p.payload->'work'->'delivery' AS delivery FROM events p
    WHERE p.work_id = e.work_id AND p.seq < e.seq AND p.payload ? 'work' ORDER BY p.seq DESC LIMIT 1) prev
  WHERE e.seq = ANY($1::bigint[]) AND e.payload ? 'work'
    AND c.cited IS DISTINCT FROM (e.payload->'work'->>'revision')
    AND prev.stage IS NOT DISTINCT FROM e.payload->'work'->'stage'
    AND prev.delivery IS NOT DISTINCT FROM e.payload->'work'->'delivery'
    AND EXISTS (SELECT 1 FROM events n WHERE n.work_id = e.work_id AND n.seq > e.seq AND (n.payload ? 'work' OR n.payload ? 'delta'))
    AND NOT EXISTS (SELECT 1 FROM events x WHERE x.seq = e.seq AND ${DELIVERY_EVENT_PREDICATE})
  ORDER BY e.seq`;

export interface LedgerCompaction { removed: Record<string, number>; total: number; batches: number; cutoff: string; cursor: number; skipped?: 'busy' }
/** GY-4080: what one compaction run removed, rows and stored payload bytes per kind, for /healthz and master status. */
export interface CompactionRun { at: string; rows: number; bytes: number; removed: Record<string, { rows: number; bytes: number }> }
let lastRun: CompactionRun | null = null;
/** The last compaction run this process finished, or null before its first. */
export const lastCompaction = () => lastRun;
const size = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(1)} KB`;
/** One line for master status: when the last run was and what it removed, largest kinds first. */
export function compactionLine(run: CompactionRun | null, now = Date.now()) {
  if (!run) return 'Compaction has not run since the server started';
  const kinds = Object.entries(run.removed).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 4).map(([kind, k]) => `${kind} ${k.rows} rows ${size(k.bytes)}`);
  return `Compaction ran ${Math.floor((now - Date.parse(run.at)) / 60_000)} min ago: removed ${run.rows} rows, ${size(run.bytes)}${kinds.length ? ` (${kinds.join(', ')})` : ''}`;
}

/**
 * Move any surviving deltas referencing `wholeSeq` forward before `wholeSeq` is deleted:
 * promotes the earliest surviving delta to a whole save and re-bases any later deltas onto it.
 * Caller must hold a row lock on `work_items(workId)` so no concurrent save can extend `wholeSeq`.
 */
async function moveBaseForward(db: pg.PoolClient, workId: string, wholeSeq: string): Promise<boolean> {
  const dependents = (await db.query(
    `SELECT seq, payload, graphyard_event_work(work_id, payload) AS doc FROM events
     WHERE work_id = $1 AND seq > $2 AND payload ? 'delta' AND payload->'delta'->>'base' = $3 ORDER BY seq`,
    [workId, wholeSeq, wholeSeq],
  )).rows as { seq: string; payload: Record<string, unknown>; doc: Work | null }[];
  if (!dependents.length) return true;
  const first = dependents[0];
  if (!first.doc) return false;
  const firstDocJson = JSON.stringify(first.doc);
  await db.query(
    `UPDATE events SET payload = (payload - 'delta' - 'stage') || jsonb_build_object('work', $2::jsonb), stage = $2::jsonb->>'stage' WHERE seq = $1`,
    [first.seq, firstDocJson],
  );
  for (const dep of dependents.slice(1)) {
    if (!dep.doc) return false;
    const { delta: _old, ...rest } = dep.payload;
    const nextPayload = {
      ...rest,
      delta: {
        base: Number(first.seq),
        revision: dep.doc.revision,
        updatedAt: dep.doc.updatedAt,
        lease: dep.doc.lease ?? null,
        submission: dep.doc.submission ?? null,
        ops: workDiff(first.doc, dep.doc),
      },
    };
    await db.query('UPDATE events SET payload = $2::jsonb WHERE seq = $1', [dep.seq, JSON.stringify(nextPayload)]);
  }
  return true;
}

/**
 * Compact expired rows of every compactable kind by kind and age (`events_kind_created`),
 * regardless of where any saved cursor stands. Runs in short independent transactions of at most
 * `batch` rows with a pause between batches until no expired row remains or `budgetMs` (or an
 * explicit `batches` limit) is spent; the next pass continues from whatever remains.
 */
export async function compactLedger(
  pool: pg.Pool,
  options: { retentionMs?: number; batch?: number; batches?: number; budgetMs?: number; actor?: string; pauseMs?: number } = {},
): Promise<LedgerCompaction> {
  const retentionMs = Math.max(0, Math.floor(options.retentionMs ?? ledgerRetentionMs));
  const boundedMs = Math.min(retentionMs, expiringRetentionMs);
  const batch = Math.max(1, Math.floor(options.batch ?? ledgerCompactionBatch));
  const maxBatches = options.batches !== undefined ? Math.max(1, Math.floor(options.batches)) : Infinity;
  const budgetMs = Math.max(0, Math.floor(options.budgetMs ?? ledgerCompactionBudgetMs));
  const pauseMs = options.pauseMs ?? ledgerCompactionPauseMs;
  const startedAt = Date.now();

  const removed: Record<string, number> = {};
  const bytes: Record<string, number> = {};
  let total = 0, ran = 0, inspected = 0, cutoff = new Date(startedAt - retentionMs), boundedCutoff = new Date(startedAt - boundedMs);
  let measured = false, lastSeq = '0', stoppedEarly = false;

  const targets: { kind: string; window: 'bounded' | 'retention'; bookkeeping: boolean }[] = [
    ...boundedKinds.map(kind => ({ kind, window: 'bounded' as const, bookkeeping: false })),
    ...routineOnlyKinds.map(kind => ({ kind, window: 'retention' as const, bookkeeping: false })),
    ...bookkeepingKinds.map(kind => ({ kind, window: 'retention' as const, bookkeeping: true })),
  ];

  outer: for (const target of targets) {
    let afterAt: string | null = null;
    let keptAtSame: string[] = [];

    for (;;) {
      if (ran >= maxBatches || (inspected > 0 && Date.now() - startedAt >= budgetMs)) {
        stoppedEarly = true;
        break outer;
      }
      const db = await pool.connect();
      let candidateCount = 0;
      const byKind: Record<string, number> = {};
      const batchBytes: Record<string, number> = {};
      try {
        await db.query('BEGIN');
        if (!(await db.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [advisoryLocks.ledgerCompaction])).rows[0].ok) {
          await db.query('ROLLBACK');
          return { removed, total, batches: ran, cutoff: new Date(cutoff).toISOString(), cursor: Number(lastSeq), skipped: 'busy' };
        }
        if (!measured) {
          measured = true;
          ({ cutoff, boundedCutoff } = (await db.query(
            `SELECT clock_timestamp() - ($1::text||' milliseconds')::interval AS cutoff, clock_timestamp() - ($2::text||' milliseconds')::interval AS "boundedCutoff"`,
            [String(retentionMs), String(boundedMs)],
          )).rows[0]);
        }
        const kindCutoff = target.window === 'bounded' ? boundedCutoff : cutoff;
        const candidates = (afterAt === null
          ? await db.query(batchLookupSql, [target.kind, kindCutoff, batch])
          : await db.query(batchLookupNextSql, [target.kind, kindCutoff, afterAt, keptAtSame, batch])
        ).rows as { seq: string; work_id: string | null; created_at_text: string }[];
        candidateCount = candidates.length;
        if (!candidateCount) {
          await db.query('COMMIT');
          break;
        }

        await db.query("SET LOCAL graphyard.ledger_compaction = 'on'");
        const candidateSeqs = candidates.map(c => c.seq);
        const rows: { seq: string; kind: string; bytes: number }[] = [];

        if (target.bookkeeping) {
          rows.push(...(await db.query(
            'DELETE FROM events WHERE seq = ANY($1::bigint[]) AND work_id IS NULL RETURNING seq, kind, pg_column_size(payload) AS bytes',
            [candidateSeqs],
          )).rows);
        } else {
          // 1. Delete loose (delta and document-less) rows first, so whole rows in this batch see fewer dependents.
          const looseSeqs = (await db.query(batchLooseSql, [candidateSeqs])).rows.map(r => r.seq as string);
          if (looseSeqs.length) {
            rows.push(...(await db.query(
              'DELETE FROM events WHERE seq = ANY($1::bigint[]) RETURNING seq, kind, pg_column_size(payload) AS bytes',
              [looseSeqs],
            )).rows);
          }
          // 2. Delete eligible whole rows after locking their items and moving any surviving delta bases forward.
          const wholeRows = (await db.query(batchWholeSql, [candidateSeqs])).rows as { seq: string; work_id: string }[];
          if (wholeRows.length) {
            const workIds = [...new Set(wholeRows.map(w => w.work_id))];
            const locked = new Set(
              (await db.query('SELECT id FROM work_items WHERE id = ANY($1::uuid[]) FOR UPDATE SKIP LOCKED', [workIds])).rows.map(r => r.id as string),
            );
            const deletableWhole: string[] = [];
            for (const w of wholeRows) {
              if (!locked.has(w.work_id)) continue;
              if (await moveBaseForward(db, w.work_id, w.seq)) deletableWhole.push(w.seq);
            }
            if (deletableWhole.length) {
              rows.push(...(await db.query(
                'DELETE FROM events WHERE seq = ANY($1::bigint[]) RETURNING seq, kind, pg_column_size(payload) AS bytes',
                [deletableWhole],
              )).rows);
            }
          }
        }

        for (const row of rows) {
          byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
          batchBytes[row.kind] = (batchBytes[row.kind] ?? 0) + Number(row.bytes);
        }
        if (rows.length) {
          const seqs = rows.map(row => Number(row.seq));
          await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [
            options.actor ?? 'graphyard',
            ledgerCompactedKind,
            JSON.stringify({
              details: {
                removed: byKind,
                total: rows.length,
                bytes: Object.values(batchBytes).reduce((sum, n) => sum + n, 0),
                bytesByKind: batchBytes,
                cutoff: new Date(kindCutoff).toISOString(),
                retentionMs: target.window === 'bounded' ? boundedMs : retentionMs,
                firstSeq: Math.min(...seqs),
                lastSeq: Math.max(...seqs),
              },
            }),
          ]);
        }
        await db.query('COMMIT');

        const deletedSet = new Set(rows.map(r => r.seq));
        const lastCandidate = candidates[candidates.length - 1];
        lastSeq = lastCandidate.seq;
        const keptAtLast = candidates.filter(c => c.created_at_text === lastCandidate.created_at_text && !deletedSet.has(c.seq)).map(c => c.seq);
        if (lastCandidate.created_at_text === afterAt) keptAtSame.push(...keptAtLast);
        else { afterAt = lastCandidate.created_at_text; keptAtSame = keptAtLast; }

        for (const [kind, n] of Object.entries(byKind)) { removed[kind] = (removed[kind] ?? 0) + n; bytes[kind] = (bytes[kind] ?? 0) + batchBytes[kind]; }
        total += rows.length;
        inspected++;
        if (rows.length) ran++;
      } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }

      if (candidateCount < batch) break;
      if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
  }

  // The registry kinds nothing reads past a week go in the same run (GY-4005), and the run is what /healthz shows.
  const expired = await expireEvents(pool, { pauseMs });
  for (const [kind, n] of Object.entries(expired.removed)) { removed[kind] = (removed[kind] ?? 0) + n; bytes[kind] = (bytes[kind] ?? 0) + expired.bytes[kind]; }
  total += expired.total;
  const byKind = Object.fromEntries(Object.entries(removed).map(([kind, rows]) => [kind, { rows, bytes: bytes[kind] }]));
  lastRun = { at: new Date().toISOString(), rows: total, bytes: Object.values(bytes).reduce((sum, n) => sum + n, 0), removed: byKind };
  return { removed, total, batches: ran, cutoff: new Date(cutoff).toISOString(), cursor: stoppedEarly ? Number(lastSeq) || 1 : 0 };
}

let freedSinceRewrite = 0;
/**
 * GY-4005: delete rows of `expiringKinds` older than the window, at most `batch` rows per short
 * transaction on the pool (never under the coordination lock), each batch audited with a
 * `ledger.compacted` row. When a catch-up that freed `rewriteAfterBytes` finishes, the events table is rewritten once
 * (VACUUM FULL, waiting at most 5 s for its lock) so its size drops instead of only its growth stopping;
 * a rewrite that fails (its lock busy, or too little disk for the copy) is not retried until the next catch-up.
 */
export async function expireEvents(pool: pg.Pool, options: { retentionMs?: number; batch?: number; batches?: number; pauseMs?: number; rewriteAfterBytes?: number } = {}) {
  const retentionMs = options.retentionMs ?? expiringRetentionMs, batch = options.batch ?? expiringBatch;
  const removed: Record<string, number> = {}, bytes: Record<string, number> = {};
  let total = 0, done = false;
  for (let ran = 0; ran < (options.batches ?? ledgerCompactionBatches) && !done; ran++) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL graphyard.ledger_compaction = 'on'");
      const rows = (await db.query(`DELETE FROM events WHERE seq = ANY(ARRAY(SELECT seq FROM events WHERE kind = ANY($1::text[]) AND work_id IS NULL
        AND created_at < clock_timestamp() - ($2::text||' milliseconds')::interval LIMIT $3)) RETURNING kind, pg_column_size(payload) AS bytes`, [[...expiringKinds], String(retentionMs), batch])).rows as { kind: string; bytes: number }[];
      const byKind: Record<string, number> = {};
      const batchBytes: Record<string, number> = {};
      for (const row of rows) { byKind[row.kind] = (byKind[row.kind] ?? 0) + 1; batchBytes[row.kind] = (batchBytes[row.kind] ?? 0) + Number(row.bytes); freedSinceRewrite += Number(row.bytes); }
      if (rows.length) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', ['graphyard', ledgerCompactedKind,
        JSON.stringify({ details: { removed: byKind, total: rows.length, bytes: Object.values(batchBytes).reduce((sum, n) => sum + n, 0), bytesByKind: batchBytes, retentionMs } })]);
      await db.query('COMMIT');
      for (const [kind, n] of Object.entries(byKind)) { removed[kind] = (removed[kind] ?? 0) + n; bytes[kind] = (bytes[kind] ?? 0) + batchBytes[kind]; }
      total += rows.length; done = rows.length < batch;
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { db.release(); }
    if (!done) await new Promise(resolve => setTimeout(resolve, options.pauseMs ?? ledgerCompactionPauseMs));
  }
  let rewritten = false;
  if (done && freedSinceRewrite >= (options.rewriteAfterBytes ?? rewriteAfterBytes)) {
    const db = await pool.connect();
    let failed: Error | undefined;
    try {
      await db.query("SET statement_timeout = 0; SET lock_timeout = '5s'");
      await db.query('VACUUM (FULL, ANALYZE) events');
      rewritten = true;
    } catch (error) { failed = error as Error; console.error('events table rewrite failed', failed.message); } finally { freedSinceRewrite = 0; db.release(failed ?? true); }
  }
  return { removed, bytes, total, done, rewritten };
}
