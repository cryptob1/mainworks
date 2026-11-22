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
    CASE WHEN kind = 'merge.trial' THEN payload ? 'flaked' END AS flaked,
    CASE WHEN kind = 'merge.serve-revert' THEN payload->>'outcome' = 'reverted' END AS reverted
  FROM events WHERE work_id IS NOT NULL AND created_at > $1 AND (payload ? 'work' OR kind = ANY($2::text[])) ORDER BY seq`;

/** The rows are read at most once a minute per database: every dashboard polls /api/status. */
const cache = new WeakMap<object, { at: number; rows: Promise<any[]> }>();
function rows(pool: Queryable, now: number) {
  const hit = cache.get(pool);
  if (hit && now - hit.at < 60_000 && now >= hit.at) return hit.rows;
  const read = pool.query(sql, [new Date(now - readSpanMs), flowKinds]).then(result => result.rows);
  cache.set(pool, { at: now, rows: read });
  read.catch(() => cache.delete(pool));
  return read;
}

type Flowed = Pick<Work, 'id' | 'key' | 'title' | 'stage' | 'stageEnteredAt' | 'delivery' | 'observation' | 'pipeline'>;
/** Each item's history: its attempts from its timeline, its stages, reworks and trials from the ledger. A trial refused because its tests fail on the base too is a flaky trial. */
export function flowItems(work: readonly Flowed[], ledger: readonly any[]): FlowItem[] {
  const events = new Map<string, FlowEvent[]>();
  for (const row of ledger) {
    const list = events.get(row.work_id) ?? [];
    const at = (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString();
    if (row.kind === 'merge.refused') {
      if (String(row.reason ?? '').startsWith(baseFailurePrefix)) { const trial = list.findLast(event => event.kind === 'merge.trial'); if (trial) trial.flaky = true; }
    } else list.push({ kind: row.kind, at, stage: row.stage ?? null, reason: row.reason ?? null, binding: row.binding ?? null, flaky: !!row.flaked, reverted: !!row.reverted });
    events.set(row.work_id, list);
  }
  return work.map(item => ({ key: item.key, title: item.title, stage: item.stage, stageEnteredAt: item.stageEnteredAt,
    mergedAt: item.delivery?.mergedAt ?? item.observation?.mergedAt ?? null,
    attempts: (item.pipeline?.attempts ?? []).map(attempt => ({ claimedAt: attempt.claimedAt, endedAt: attempt.endedAt, end: attempt.end ?? null })),
    events: events.get(item.id) ?? [] }));
}

export type Flow = Record<FlowWindow, FlowNumbers> & { attention: ReturnType<typeof flowAttention> };
/** The flow numbers for 6 hours, 24 hours and 7 days over `work`, and the attention line the 24 hours raise. */
export async function readFlow(pool: Queryable, work: readonly Flowed[], now: number): Promise<Flow> {
  const items = flowItems(work, await rows(pool, now));
  const windows = Object.fromEntries(Object.entries(flowWindows).map(([name, hours]) => [name, flowNumbers(items, hours, now)])) as Record<FlowWindow, FlowNumbers>;
  return { ...windows, attention: flowAttention(windows['24h']) };
}
