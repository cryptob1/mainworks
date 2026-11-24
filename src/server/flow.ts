// Concern: GY-3624 — the ledger rows the flow numbers read, turned into item histories, and the numbers for each window.
import type { Work } from '../model.js';
import { baseFailurePrefix } from '../model/merge-queue.js';
import type { DeployHistoryEntry, GitRead } from '../deploy-watch.js';
import { flowAttention, flowNumbers, flowWindows, type FlowEvent, type FlowItem, type FlowNumbers, type FlowWindow } from '../flow-numbers.js';

interface Queryable { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }
const flowKinds = ['rework', 'merge.intent', 'merge.trial', 'merge.refused', 'merge.serve-revert'];
/** GY-3763: the longest window the flow reports; nothing older is read. */
const readSpanMs = 7 * 24 * 3_600_000;
const columns = `work_id, kind, created_at, seq,
    CASE WHEN payload ? 'work' THEN payload->'work'->>'stage' END AS stage,
    CASE WHEN kind = 'rework' THEN COALESCE(payload->'details'->>'reason', payload->'details'->'intent'->>'reason')
      WHEN kind = 'merge.refused' THEN payload->>'reason' END AS reason,
    CASE WHEN kind = 'rework' THEN COALESCE(payload->'details'->>'binding', payload->'details'->'intent'->>'binding') END AS binding,
    CASE WHEN kind IN ('merge.trial', 'merge.refused') THEN payload->>'head' END AS head,
    CASE WHEN kind = 'merge.trial' THEN payload->>'durationMs' END AS duration_ms,
    CASE WHEN kind = 'merge.trial' THEN payload ? 'flaked' END AS flaked,
    CASE WHEN kind = 'merge.serve-revert' THEN payload->>'outcome' = 'reverted' END AS reverted`;
/**
 * GY-3763: the window's rows, each half a range scan on insertion time: the whole-document rows
 * through events_work_flow, the flow kinds through events_kind_created. Neither tests a payload
 * outside the window.
 */
export const flowLedgerSql = `SELECT ${columns} FROM events WHERE work_id IS NOT NULL AND created_at > $1 AND payload ? 'work'
  UNION ALL SELECT ${columns} FROM events WHERE work_id IS NOT NULL AND created_at > $1 AND kind = ANY($2::text[]) AND NOT (payload ? 'work')
  ORDER BY seq`;

/**
 * Each item's attempts from its own document, only the three fields the flow reads: the fleet serves
 * a settled delivery as the work index's summary, without its timeline, and a hot path returns no
 * settled document's history. Only items open, merged or written to within the window are read.
 */
export const flowAttemptsSql = `SELECT w.id, (SELECT jsonb_agg(jsonb_build_object('claimedAt', a->'claimedAt', 'endedAt', a->'endedAt', 'end', a->'end'))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.document->'pipeline'->'attempts') = 'array' THEN w.document->'pipeline'->'attempts' ELSE '[]'::jsonb END) a) AS attempts
  FROM work_items w JOIN work_index i ON i.id = w.id
  WHERE NOT i.settled OR i.merged_at > $1 OR w.id IN (SELECT work_id FROM events WHERE created_at > $1 AND work_id IS NOT NULL)`;
type Attempts = Map<string, { claimedAt: string; endedAt: string | null; end?: string | null }[]>;

async function rows(pool: Queryable, now: number) {
  const since = new Date(now - readSpanMs);
  const [ledger, attempts] = await Promise.all([pool.query(flowLedgerSql, [since, flowKinds]), pool.query(flowAttemptsSql, [since])]);
  return { ledger: ledger.rows, attempts: new Map(attempts.rows.filter(row => Array.isArray(row.attempts)).map(row => [row.id, row.attempts])) as Attempts };
}

type Flowed = Pick<Work, 'id' | 'key' | 'title' | 'stage' | 'stageEnteredAt' | 'delivery' | 'observation'>;
/**
 * Each item's history: its attempts from its timeline, its stages, reworks and trials from the
 * ledger. A trial is flaky when its rerun passed, or when the refusal that answers it — the item's
 * next refusal, of the same head — finds its failing tests fail on the base too. A head held for a
 * red base is refused without a trial of its own, so that refusal flags none.
 */
export function flowItems(work: readonly Flowed[], ledger: readonly any[], attempts: Attempts = new Map(), deployed: ReadonlyMap<string, string | null> = new Map()): FlowItem[] {
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
    ...(deployed.has(item.id) ? { deployedAt: deployed.get(item.id) } : {}),
    attempts: (attempts.get(item.id) ?? []).map(attempt => ({ claimedAt: attempt.claimedAt, endedAt: attempt.endedAt, end: attempt.end ?? null })),
    events: events.get(item.id) ?? [] }));
}

/**
 * GY-3725: each merge's first serving deploy, fixed once found, so a read walks only the merges not
 * yet serving and only the deploys since the oldest of them. A merge found missing from the newest
 * deploy is not walked again until a newer deploy lands.
 */
const served = new Map<string, string | { missingFrom: string }>();
async function resolveDeployedAt(work: readonly Flowed[], deploys: readonly DeployHistoryEntry[], git: GitRead | null | undefined, now: number): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const newest = deploys.at(-1);
  if (!newest || !git) return result;
  const from = now - readSpanMs;
  const candidates = work.flatMap(item => {
    const mergedAt = item.delivery?.mergedAt ?? item.observation?.mergedAt ?? null;
    const sha = item.delivery?.mergeSha?.toLowerCase();
    const at = mergedAt ? Date.parse(mergedAt) : Number.NaN;
    return sha && /^[0-9a-f]{40}$/.test(sha) && Number.isFinite(at) && at > from && at <= now ? [{ id: item.id, sha, at }] : [];
  });
  const inWindow = new Set(candidates.map(candidate => candidate.sha));
  for (const sha of served.keys()) if (!inWindow.has(sha)) served.delete(sha);
  const pending = candidates.filter(candidate => {
    const hit = served.get(candidate.sha);
    return hit === undefined || (typeof hit !== 'string' && hit.missingFrom !== newest.commit);
  });
  if (pending.length) {
    const since = Math.min(...pending.map(candidate => candidate.at)) - 60_000;
    const recent = deploys.filter(entry => Date.parse(entry.at) >= since);
    const unmatched = new Set(pending.map(candidate => candidate.sha));
    const walked: string[] = [];
    for (const deploy of recent.length ? recent : [newest]) {
      if (!unmatched.size) break;
      try {
        const output = await git(['rev-list', ...(walked.length ? [] : ['--max-count=5000']), deploy.commit, ...walked.map(commit => `^${commit}`)]);
        for (const line of output.split('\n')) {
          const sha = line.trim().toLowerCase();
          if (unmatched.delete(sha)) served.set(sha, deploy.at);
        }
        walked.push(deploy.commit);
      } catch { /* commit missing in this checkout */ }
    }
    if (walked.length) for (const sha of unmatched) {
      try { await git(['cat-file', '-e', `${sha}^{commit}`]); served.set(sha, { missingFrom: newest.commit }); } catch { /* not in this checkout */ }
    }
  }
  for (const candidate of candidates) {
    const hit = served.get(candidate.sha);
    if (typeof hit === 'string') result.set(candidate.id, hit);
    else if (hit) result.set(candidate.id, null);
  }
  return result;
}

interface FlowLiveOptions { deploys?: readonly DeployHistoryEntry[]; git?: GitRead | null }
export type Flow = Record<FlowWindow, FlowNumbers> & { attention: ReturnType<typeof flowAttention> };
/** The flow as every reader gets it: the stored numbers, when they were computed and how long ago. */
export type FlowReport = Flow & { asOf: string; ageSeconds: number };

function numbers(items: readonly FlowItem[], now: number): Flow {
  const windows = Object.fromEntries(Object.entries(flowWindows).map(([name, hours]) => [name, flowNumbers(items, hours, now)])) as Record<FlowWindow, FlowNumbers>;
  return { ...windows, attention: flowAttention(windows['24h']) };
}

/** The flow numbers for 6 hours, 24 hours and 7 days over `work`, and the attention line the 24 hours raise. */
export async function readFlow(pool: Queryable, work: readonly Flowed[], now: number, live?: FlowLiveOptions): Promise<Flow & { items: FlowItem[] }> {
  const [{ ledger, attempts }, deployed] = await Promise.all([
    rows(pool, now),
    live?.deploys?.length && live.git ? resolveDeployedAt(work, live.deploys, live.git, now) : Promise.resolve(new Map<string, string | null>()),
  ]);
  const items = flowItems(work, ledger, attempts, deployed);
  return { ...numbers(items, now), items };
}

type Stored = { at: number; work: readonly (Flowed & { reportedBy?: string })[]; flow: Flow & { items: FlowItem[] } };
const jobs = new WeakMap<object, { last?: Stored; running?: Promise<Stored> }>();
/** Drops the stored flow so the next reader computes it again: a test that changes the ledger and reads again within the minute. */
export const forgetFlow = (key: object) => { jobs.delete(key); };
/**
 * GY-3763: one computation per server at most once a minute, shared by every reader. A reader gets
 * the stored result with its age; one that finds it a minute old starts the next computation and
 * still answers from the stored one. Only the first read ever waits.
 */
export async function sharedFlow(key: object, now: number, compute: (now: number) => Promise<Stored>,
  visible: <T extends { id: string; key: string }>(items: T[]) => T[] = items => items): Promise<FlowReport> {
  let job = jobs.get(key);
  if (!job) jobs.set(key, job = {});
  if (!job.running && (!job.last || now - job.last.at >= 60_000)) {
    const own = job, running = compute(now).then(result => (own.last = result));
    own.running = running;
    running.finally(() => { if (own.running === running) own.running = undefined; }).catch(() => {});
  }
  const stored = job.last ?? await job.running!;
  // A reporter sees only its own items: its numbers come from the stored histories, not a new read.
  const keys = new Set(visible([...stored.work]).map(item => item.key));
  const { items: _items, ...flow } = keys.size === stored.work.length ? stored.flow : { ...numbers(stored.flow.items.filter(item => keys.has(item.key)), stored.at), items: [] };
  return { ...flow, asOf: new Date(stored.at).toISOString(), ageSeconds: Math.max(0, Math.round((now - stored.at) / 1000)) };
}
