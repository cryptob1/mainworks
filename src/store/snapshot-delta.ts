import type pg from 'pg';
import type { Lease, Work } from '../model.js';
import { DELIVERY_EVENT_PREDICATE } from './tables/production.js';

/**
 * Ledger rows stored as a delta against the item's last full snapshot.
 *
 * Every save appends the work document it produced. Copying the whole document for each of
 * the continuous writes — reconciliation passes, lease renewals, action-queue claims and
 * failures, dispatch and loop bookkeeping — was nearly all of the ledger's growth, though each
 * changes a few fields. A save of any kind is therefore stored as `payload.delta` when the item
 * has a recent full snapshot: `base` (that snapshot's `seq`), the replay fields (`revision`,
 * `updatedAt`, `lease`, `submission`) and `ops`, the edits that turn the base into this
 * document. Deltas are always taken against the full snapshot, never chained, so any row is
 * one base lookup away from its document (`graphyard_event_work` in SQL).
 *
 * A full snapshot is written for the first save, every `snapshotEvery` rows, when the delta
 * would exceed `deltaSizeFraction` of the document, when the stage or delivery changed (so
 * lifecycle rows stay whole), and for an item's first accepted-delivery observation (the row
 * the delivery index reads). Nothing is updated; only the audited compaction of routine rows
 * past their retention window deletes (store/compaction.ts).
 *
 * A routine save (`routineSaveKinds`: the continuous writes nobody reads as a lifecycle step) is
 * never a full snapshot once the item has one (GY-979): it is a delta on that snapshot however
 * many rows follow it and however large the delta, unless it moves the stage or the delivery —
 * then it is a lifecycle row and stays whole whatever its kind. Full snapshots written by routine
 * kinds were 8 GB of a 9 GB ledger in production. The `snapshotEvery` and size rules now apply to
 * the other kinds alone, so a routine delta can sit any number of rows after its base.
 *
 * A delta row also carries `stage`, the item's stage, so reading stages never resolves documents (GY-3766).
 *
 * Rows written before this generalisation carry a clock-only delta (`observation`, `lease`,
 * no `ops`); `graphyard_event_work` still resolves them.
 */
export const snapshotEvery = 50;
const deltaSizeFraction = 0.25;
/** The save kinds that store only what changed, never a whole document (GY-979). */
export const routineSaveKinds = ['github.observed', 'heartbeat', 'reconciled', 'action.claimed', 'action.failed', 'session'] as const;
const routineSave: ReadonlySet<string> = new Set(routineSaveKinds);

type DeltaPath = (string | number)[];
/** `[path, value]` sets a value (appending when the index is an array's length); `[path]` removes an object key. */
export type DeltaOp = [DeltaPath, unknown] | [DeltaPath];
export interface WorkDelta {
  /** The `seq` of the full snapshot this row extends. */
  base: number;
  revision: number;
  updatedAt: string;
  lease: Lease | null;
  submission: Work['submission'] | null;
  ops: DeltaOp[];
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((entry, index) => equal(entry, b[index]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]));
  }
  return false;
}
function diff(base: unknown, next: unknown, path: DeltaPath, ops: DeltaOp[]) {
  if (equal(base, next)) return;
  if (isObject(base) && isObject(next)) {
    for (const key of Object.keys(base)) if (!Object.prototype.hasOwnProperty.call(next, key)) ops.push([[...path, key]]);
    for (const key of Object.keys(next)) {
      if (Object.prototype.hasOwnProperty.call(base, key)) diff(base[key], next[key], [...path, key], ops);
      else ops.push([[...path, key], next[key]]);
    }
    return;
  }
  if (Array.isArray(base) && Array.isArray(next) && path.length && next.length >= base.length) {
    base.forEach((entry, index) => diff(entry, next[index], [...path, index], ops));
    for (let index = base.length; index < next.length; index++) ops.push([[...path, index], next[index]]);
    return;
  }
  ops.push([path, next]);
}
/** The edits that turn `base` into `next`; both are JSON documents. */
export function workDiff(base: Work, next: Work): DeltaOp[] {
  const ops: DeltaOp[] = [];
  diff(base, next, [], ops);
  return ops;
}
function workDelta(baseSeq: number, base: Work, work: Work): WorkDelta {
  return { base: baseSeq, revision: work.revision, updatedAt: work.updatedAt, lease: work.lease ?? null, submission: work.submission ?? null, ops: workDiff(base, work) };
}

/**
 * Installed with the events table: `graphyard_event_work` reads an event's full document
 * from its own `payload`, whether it carries the document whole or a delta on a full snapshot.
 * `graphyard_work_at_revision` finds the document an item held at a revision: the exact full
 * snapshot by index, else the delta row within `snapshotEvery` rows of its base, else — a routine
 * delta any distance from its base (GY-979) — the item's delta row carrying that revision.
 */
export const eventWorkFunctions = `CREATE OR REPLACE FUNCTION graphyard_event_work(p_work uuid, p_payload jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $fn$
DECLARE d jsonb; result jsonb; op jsonb; path text[];
BEGIN
  IF p_payload ? 'work' THEN RETURN p_payload->'work'; END IF;
  d := p_payload->'delta';
  IF d IS NULL THEN RETURN NULL; END IF;
  SELECT e.payload->'work' INTO result FROM events e WHERE e.seq=(d->>'base')::bigint AND e.work_id=p_work;
  IF result IS NULL THEN RETURN NULL; END IF;
  IF d ? 'ops' THEN
    FOR op IN SELECT value FROM jsonb_array_elements(d->'ops') WITH ORDINALITY ORDER BY ordinality LOOP
      path := ARRAY(SELECT jsonb_array_elements_text(op->0));
      IF jsonb_array_length(op) = 1 THEN
        IF jsonb_typeof(result #> path[1:array_length(path,1)-1]) = 'object' THEN result := result #- path; END IF;
      ELSE result := jsonb_set(result, path, op->1, true); END IF;
    END LOOP;
    RETURN result;
  END IF;
  result := jsonb_set(jsonb_set(result, '{revision}', d->'revision'), '{updatedAt}', d->'updatedAt');
  IF jsonb_typeof(result->'observation')='object' AND jsonb_typeof(d->'observation')='object' THEN
    result := jsonb_set(result, '{observation,at}', d->'observation'->'at');
    IF jsonb_typeof(d->'observation'->'clockOffset')='object' THEN result := jsonb_set(result, '{observation,clockOffset}', d->'observation'->'clockOffset');
    ELSE result := result #- '{observation,clockOffset}'; END IF;
  END IF;
  IF jsonb_typeof(result->'lease')='object' AND jsonb_typeof(d->'lease')='object' THEN result := jsonb_set(result, '{lease,expiresAt}', d->'lease'->'expiresAt'); END IF;
  RETURN result;
END $fn$;
CREATE OR REPLACE FUNCTION graphyard_work_at_revision(p_work uuid, p_revision text) RETURNS jsonb
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $fn$
DECLARE found jsonb; base_seq bigint;
BEGIN
  SELECT e.payload->'work' INTO found FROM events e WHERE e.work_id=p_work AND e.payload ? 'work' AND e.payload->'work'->>'revision'=p_revision ORDER BY e.seq DESC LIMIT 1;
  IF found IS NOT NULL OR p_revision IS NULL OR p_revision !~ '^[0-9]{1,15}$' THEN RETURN found; END IF;
  SELECT max(e.seq) INTO base_seq FROM events e WHERE e.work_id=p_work AND e.payload ? 'work'
    AND e.payload->'work'->>'revision' = ANY(ARRAY(SELECT (p_revision::bigint - g)::text FROM generate_series(1, ${snapshotEvery}) g));
  IF base_seq IS NOT NULL THEN SELECT graphyard_event_work(x.work_id, x.payload) INTO found
    FROM (SELECT e.work_id, e.payload FROM events e WHERE e.work_id=p_work AND e.seq>base_seq ORDER BY e.seq LIMIT ${snapshotEvery}) x
    WHERE x.payload ? 'delta' AND x.payload->'delta'->>'revision'=p_revision LIMIT 1; END IF;
  IF found IS NOT NULL THEN RETURN found; END IF;
  SELECT graphyard_event_work(e.work_id, e.payload) INTO found FROM events e
    WHERE e.work_id=p_work AND e.payload ? 'delta' AND e.payload->'delta'->>'revision'=p_revision ORDER BY e.seq DESC LIMIT 1;
  RETURN found;
END $fn$;`;

/** Read the whole-row stage column before opening its document; delta stages live in the small payload. */
export const eventStageSql = (alias = 'events') => `COALESCE(${alias}.stage, ${alias}.payload->>'stage', ${alias}.payload->'work'->>'stage', ${eventWorkSql(alias)}->>'stage')`;
/** An event's full document in SQL, for a row of `events` under `alias`. */
export const eventWorkSql = (alias = 'events') => `graphyard_event_work(${alias}.work_id, ${alias}.payload)`;
/** An event's payload with a delta replaced by the document it stands for: the shape every full row has. */
export const resolvedPayloadSql = (alias = 'events') =>
  `CASE WHEN ${alias}.payload ? 'delta' THEN (${alias}.payload - 'delta' - 'stage') || jsonb_build_object('work', ${eventWorkSql(alias)}) ELSE ${alias}.payload END`;

/** The one ledger read a save makes: the item's last full snapshot and how many rows followed it. */
const snapshotBaseSql = `SELECT b.seq, b.payload->'work' AS work, (SELECT count(*)::int FROM events n WHERE n.work_id=$1 AND n.seq>b.seq) AS since
    FROM events b WHERE b.work_id=$1 AND b.payload ? 'work' ORDER BY b.seq DESC LIMIT 1`;
/**
 * Append one save to the ledger: a delta on the item's last full snapshot when it is small
 * and recent, or whenever the save is routine; the whole document otherwise.
 */
export async function appendSave(db: pg.PoolClient, work: Work, actor: string, kind: string, details?: unknown, text = JSON.stringify(work)) {
  // `text` is the document as `save` just wrote it; it is parsed only to diff against a snapshot.
  const detailText = JSON.stringify(details) as string | undefined;
  const full = detailText === undefined ? `{"work":${text}}` : `{"work":${text},"details":${detailText}}`;
  const base = (await db.query(snapshotBaseSql, [work.id])).rows[0] as { seq: string; work: Work; since: number } | undefined;
  const routine = routineSave.has(kind);
  let row = full;
  const document: Work | undefined = base?.work && JSON.parse(text);
  if (base?.work && document && (routine || base.since < snapshotEvery) && base.work.stage === document.stage && equal(base.work.delivery ?? null, document.delivery ?? null)
    && !(kind === 'github.observed' && document.delivery?.mergedAt && !(await db.query(`SELECT 1 FROM events WHERE work_id=$1 AND ${DELIVERY_EVENT_PREDICATE} LIMIT 1`, [work.id])).rows.length)) {
    // The stage rides beside the delta so a stage read never rebuilds the document (GY-3766).
    const delta = JSON.stringify({ delta: workDelta(Number(base.seq), base.work, document), stage: document.stage, details });
    if (routine || delta.length <= full.length * deltaSizeFraction) row = delta;
  }
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, actor, kind, row]);
}

