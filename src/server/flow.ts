// Concern: GY-3624 — the ledger rows the flow numbers read, turned into item histories, and the numbers for each window.
import type { Work } from '../model.js';
import { baseFailurePrefix } from '../model/merge-queue.js';
import { flowAttention, flowNumbers, flowWindows, type FlowEvent, type FlowItem, type FlowNumbers, type FlowWindow } from '../flow-numbers.js';

interface Queryable { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }
const flowKinds = ['rework', 'merge.intent', 'merge.trial', 'merge.refused', 'merge.serve-revert'];
/** The 7-day window and a day before it, so a stay that began before the window is timed from its start. */
const readSpanMs = 8 * 24 * 3_600_000;
const sql = `SELECT work_id, kind, created_at,
    CASE WHEN payload ? 'work' THEN payload->'work'->>'stage' END AS stage,
    CASE WHEN kind = 'rework' THEN COALESCE(payload->'details'->>'reason', payload->'details'->'intent'->>'reason')
      WHEN kind = 'merge.refused' THEN payload->>'reason' END AS reason,
    CASE WHEN kind = 'rework' THEN COALESCE(payload->'details'->>'binding', payload->'details'->'intent'->>'binding') END AS binding,
    CASE WHEN kind IN ('merge.trial', 'merge.refused') THEN payload->>'head' END AS head,
    CASE WHEN kind = 'merge.trial' THEN payload->>'durationMs' END AS duration_ms,
    CASE WHEN kind = 'merge.trial' THEN payload ? 'flaked' END AS flaked,
    CASE WHEN kind = 'merge.serve-revert' THEN payload->>'outcome' = 'reverted' END AS reverted
  FROM events WHERE work_id IS NOT NULL AND created_at > $1 AND (payload ? 'work' OR kind = ANY($2::text[])) ORDER BY seq`;

/**
 * Each item's attempts from its own document: the fleet serves a settled delivery as the work
 * index's summary, without its timeline. Only items open, or written to within the read span, are read.
 */
const attemptsSql = `SELECT w.id, w.document->'pipeline'->'attempts' AS attempts FROM work_items w JOIN work_index i ON i.id = w.id
  WHERE NOT i.settled OR i.merged_at > $1 OR w.id IN (SELECT work_id FROM events WHERE created_at > $1 AND work_id IS NOT NULL)`;
type Attempts = Map<string, { claimedAt: string; endedAt: string | null; end?: string | null }[]>;

/** The rows are read at most once a minute per database: every dashboard polls /api/status. */
const cache = new WeakMap<object, { at: number; rows: Promise<{ ledger: any[]; attempts: Attempts }> }>();
function rows(pool: Queryable, now: number) {
  const hit = cache.get(pool);
  if (hit && now - hit.at < 60_000 && now >= hit.at) return hit.rows;
  const since = new Date(now - readSpanMs);
  const read = Promise.all([pool.query(sql, [since, flowKinds]), pool.query(attemptsSql, [since])]).then(([ledger, attempts]) => ({ ledger: ledger.rows,
    attempts: new Map(attempts.rows.filter(row => Array.isArray(row.attempts)).map(row => [row.id, row.attempts])) as Attempts }));
  cache.set(pool, { at: now, rows: read });
  read.catch(() => cache.delete(pool));
  return read;
}

type Flowed = Pick<Work, 'id' | 'key' | 'title' | 'stage' | 'stageEnteredAt' | 'delivery' | 'observation'>;
/**
 * Each item's history: its attempts from its timeline, its stages, reworks and trials from the
 * ledger. A trial is flaky when its rerun passed, or when the refusal that answers it — the item's
 * next refusal, of the same head — finds its failing tests fail on the base too. A head held for a
 * red base is refused without a trial of its own, so that refusal flags none.
 */
export function flowItems(work: readonly Flowed[], ledger: readonly any[], attempts: Attempts = new Map()): FlowItem[] {
  const events = new Map<string, FlowEvent[]>(), unanswered = new Map<string, FlowEvent>();
  for (const row of ledger) {
    const list = events.get(row.work_id) ?? [];
    const at = (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString();
    if (row.kind === 'merge.refused') {
      const trial = unanswered.get(row.work_id);
      unanswered.delete(row.work_id);
      if (trial && trial.head === row.head && String(row.reason ?? '').startsWith(baseFailurePrefix)) trial.flaky = true;
    } else {
      const event: FlowEvent = { kind: row.kind, at, stage: row.stage ?? null, reason: row.reason ?? null, binding: row.binding ?? null, head: row.head ?? null,
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms), flaky: !!row.flaked, reverted: !!row.reverted };
      list.push(event);
      if (row.kind === 'merge.trial') unanswered.set(row.work_id, event);
      else if (row.kind === 'merge.intent') unanswered.delete(row.work_id);
    }
    events.set(row.work_id, list);
  }
  return work.map(item => ({ key: item.key, title: item.title, stage: item.stage, stageEnteredAt: item.stageEnteredAt,
    mergedAt: item.delivery?.mergedAt ?? item.observation?.mergedAt ?? null,
    attempts: (attempts.get(item.id) ?? []).map(attempt => ({ claimedAt: attempt.claimedAt, endedAt: attempt.endedAt, end: attempt.end ?? null })),
    events: events.get(item.id) ?? [] }));
}

export type Flow = Record<FlowWindow, FlowNumbers> & { attention: ReturnType<typeof flowAttention> };
/** The flow numbers for 6 hours, 24 hours and 7 days over `work`, and the attention line the 24 hours raise. */
export async function readFlow(pool: Queryable, work: readonly Flowed[], now: number): Promise<Flow> {
  const { ledger, attempts } = await rows(pool, now);
  const items = flowItems(work, ledger, attempts);
  const windows = Object.fromEntries(Object.entries(flowWindows).map(([name, hours]) => [name, flowNumbers(items, hours, now)])) as Record<FlowWindow, FlowNumbers>;
  return { ...windows, attention: flowAttention(windows['24h']) };
}
