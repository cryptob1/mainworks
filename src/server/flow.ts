// Concern: GY-3624 — the ledger rows the flow numbers read, turned into item histories, and the numbers for each window.
import type { Work } from '../model.js';
import { baseFailurePrefix, trialAheadOfReviewPrefix } from '../model/merge-queue.js';
import { unproducedManualProofs } from '../model/unproduced-attestation.js';
import type { DeployHistoryEntry, GitRead } from '../deploy-watch.js';
import { flowAttention, flowNumbers, flowWindows, type FlakeEvent, type FlowEvent, type FlowItem, type FlowNumbers, type FlowWindow } from '../flow-numbers.js';
import { deriveNotMoving, type HeldItem, type NotMovingItem } from '../daemon/stall-alarm.js';

interface Queryable { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }
export const flowKinds = ['rework', 'merge.intent', 'merge.trial', 'merge.refused', 'merge.serve-revert', 'blocked', 'unblock', 'hold', 'ready'];
/** GY-3763: the longest window the flow reports; nothing older is read. */
const readSpanMs = 7 * 24 * 3_600_000;
const columns = `work_id, kind, created_at, seq, stage,
    CASE WHEN kind = 'rework' THEN COALESCE(payload->'details'->>'reason', payload->'details'->'intent'->>'reason')
      WHEN kind = 'merge.refused' THEN payload->>'reason' END AS reason,
    CASE WHEN kind = 'rework' THEN COALESCE(payload->'details'->>'binding', payload->'details'->'intent'->>'binding') END AS binding,
    CASE WHEN kind IN ('merge.trial', 'merge.refused') THEN payload->>'head' END AS head,
    CASE WHEN kind = 'merge.trial' THEN payload->>'baseTip' END AS base_tip,
    CASE WHEN kind = 'merge.trial' THEN payload->>'durationMs' END AS duration_ms,
    CASE WHEN kind = 'merge.trial' THEN payload ? 'flaked' END AS flaked,
    CASE WHEN kind = 'merge.trial' THEN jsonb_build_object('flaked', payload->'flaked', 'failed', payload->'tests'->'failed', 'assertions', payload->'tests'->'assertions') END AS trial,
    CASE WHEN kind = 'merge.serve-revert' THEN payload->>'outcome' = 'reverted' END AS reverted`;
/**
 * GY-3763: the window's rows, each half a range scan on insertion time: the whole-document rows
 * through events_work_flow, the flow kinds through events_kind_created. Neither tests a payload
 * outside the window. GY-3765: a whole-document row's stage is its own column, so only a rework's
 * document is opened, for its reason; a row with no stage carries no document.
 */
export const flowLedgerSql = `SELECT ${columns} FROM events WHERE work_id IS NOT NULL AND created_at > $1 AND payload ? 'work'
  UNION ALL SELECT ${columns} FROM events WHERE work_id IS NOT NULL AND created_at > $1 AND kind = ANY($2::text[]) AND stage IS NULL
  ORDER BY seq`;

/**
 * Each item's attempts, the three fields the flow reads, from the work index (GY-3764): no event and
 * no whole document is read. Only items open, merged within the window, or whose stage or attempts
 * changed within it are read; an item with neither had no attempt end inside the window.
 */
export const flowAttemptsSql = `SELECT id, attempts FROM work_index WHERE attempts IS NOT NULL AND (NOT settled OR merged_at > $1 OR touched_at > $1)`;
type Attempts = Map<string, { claimedAt: string; endedAt: string | null; end?: string | null }[]>;

/**
 * GY-4059: the repository's onboarding, from timestamps already recorded: connected at the control
 * plane's first schema record or its first work item, whichever is earlier, to its first merge.
 */
export const onboardingSql = `SELECT LEAST((SELECT min(applied_at) FROM graphyard_schema),
  (SELECT (w.document->>'createdAt')::timestamptz FROM work_index i JOIN work_items w ON w.id = i.id ORDER BY i.number LIMIT 1)) AS connected_at,
  (SELECT min(merged_at) FROM work_index) AS merged_at`;
/** One connected repository's onboarding: minutes from connection to first merge, or waiting so far. */
export interface OnboardingTime { repository: string; connectedAt: string; firstMergeAt: string | null; minutes: number; waiting: boolean }
async function onboarding(pool: Queryable, repository: string | null | undefined, now: number): Promise<OnboardingTime[]> {
  const row = (await pool.query(onboardingSql, [])).rows[0];
  if (!row?.connected_at) return [];
  const connected = new Date(row.connected_at).getTime(), merged = row.merged_at ? new Date(row.merged_at).getTime() : null;
  return [{ repository: repository ?? 'This repository', connectedAt: new Date(connected).toISOString(), firstMergeAt: merged === null ? null : new Date(merged).toISOString(),
    minutes: Math.max(0, Math.round(((merged ?? now) - connected) / 60_000)), waiting: merged === null }];
}

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
export function flowItems(work: readonly Flowed[], ledger: readonly any[], attempts: Attempts = new Map(), deployed: ReadonlyMap<string, string | null> = new Map(), now = Date.now()): FlowItem[] {
  const events = new Map<string, FlowEvent[]>(), unanswered = new Map<string, FlowEvent>();
  for (const row of ledger) {
    const list = events.get(row.work_id) ?? [];
    const at = (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString();
    if (row.kind === 'merge.refused') {
      const trial = unanswered.get(row.work_id);
      unanswered.delete(row.work_id);
      const reason = String(row.reason ?? '');
      if (trial && trial.head === row.head && reason.startsWith(baseFailurePrefix)) { trial.flaky = true; delete trial.failures; }
      if (reason.startsWith(trialAheadOfReviewPrefix) && /acceptance gate awaits .*manual:/.test(reason))
        list.push({ kind: row.kind, at, reason: row.reason ?? null, head: row.head ?? null });
    } else {
      const flakes = row.flakes ?? row.trial?.flaked, failed = row.trial?.failed, assertions = row.trial?.assertions;
      const event: FlowEvent = { kind: row.kind, at, stage: row.stage ?? null, reason: row.reason ?? null, binding: row.binding ?? null, head: row.head ?? null, base: row.base_tip ?? null,
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms), flaky: !!row.flaked,
        ...(flakes ? { flakes: (flakes.files as string[]).map(file => ({ file, at, assertion: flakes.assertions?.[file] ?? null })) } : {}),
        ...(Array.isArray(failed) && failed.length ? { failures: (failed as string[]).map(file => ({ file, at, assertion: assertions?.[file] ?? null })) } : {}), reverted: !!row.reverted };
      list.push(event);
      if (row.kind === 'merge.trial') unanswered.set(row.work_id, event);
      else if (row.kind === 'merge.intent') unanswered.delete(row.work_id);
    }
    events.set(row.work_id, list);
  }
  const full = work.filter((item): item is Work => 'gates' in item && Array.isArray((item as Work).gates) && Array.isArray((item as Work).criteria) && Array.isArray((item as Work).violations));
  const atNow = new Date(now);
  return work.map(item => {
    const awaitingSignoff = item.stage === 'acceptance' && 'gates' in item && Array.isArray((item as Work).gates) && Array.isArray((item as Work).criteria) && Array.isArray((item as Work).violations)
      ? unproducedManualProofs(item as Work, full, atNow).length > 0 : false;
    return { key: item.key, title: item.title, stage: item.stage, stageEnteredAt: item.stageEnteredAt,
      mergedAt: item.delivery?.mergedAt ?? item.observation?.mergedAt ?? null,
      ...(deployed.has(item.id) ? { deployedAt: deployed.get(item.id) } : {}),
      ...(awaitingSignoff ? { awaitingSignoff: true } : {}),
      attempts: (attempts.get(item.id) ?? []).map(attempt => ({ claimedAt: attempt.claimedAt, endedAt: attempt.endedAt, end: attempt.end ?? null })),
      events: events.get(item.id) ?? [] };
  });
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

interface FlowLiveOptions { repository?: string | null; deploys?: readonly DeployHistoryEntry[]; git?: GitRead | null; releaseFlakes?: readonly FlakeEvent[] }
export type Flow = Record<FlowWindow, FlowNumbers> & { attention: ReturnType<typeof flowAttention>; onboarding: OnboardingTime[] };
/** The flow as every reader gets it: the stored numbers, when they were computed and how long ago. */
export type FlowReport = Flow & { asOf: string; ageSeconds: number };
export type NotMovingReport = { notMoving: NotMovingItem[]; waitingOnPerson: NotMovingItem[]; held: HeldItem[]; asOf: string; ageSeconds: number };

function numbers(items: readonly FlowItem[], now: number, releaseFlakes: readonly FlakeEvent[] = []): Omit<Flow, 'onboarding'> {
  const windows = Object.fromEntries(Object.entries(flowWindows).map(([name, hours]) => [name, flowNumbers(items, hours, now, releaseFlakes)])) as Record<FlowWindow, FlowNumbers>;
  return { ...windows, attention: flowAttention(windows['24h']) };
}

/** The flow numbers for 6 hours, 24 hours and 7 days over `work`, and the attention line the 24 hours raise. */
export async function readFlow(pool: Queryable, work: readonly Flowed[], now: number, live?: FlowLiveOptions): Promise<Flow & { items: FlowItem[]; notMoving: NotMovingItem[]; waitingOnPerson: NotMovingItem[]; held: HeldItem[] }> {
  const [{ ledger, attempts }, deployed, onboarded] = await Promise.all([
    rows(pool, now),
    live?.deploys?.length && live.git ? resolveDeployedAt(work, live.deploys, live.git, now) : Promise.resolve(new Map<string, string | null>()),
    onboarding(pool, live?.repository, now),
  ]);
  const items = flowItems(work, ledger, attempts, deployed, now);
  const eventsByWork = new Map(work.map((item, i) => [item.id, items[i]!.events]));
  const stall = deriveNotMoving(work as readonly Work[], now, eventsByWork);
  return { ...numbers(items, now, live?.releaseFlakes), onboarding: onboarded, items, ...stall };
}

type Stored = { at: number; work: readonly (Flowed & { reportedBy?: string })[]; flow: Flow & { items: FlowItem[]; notMoving: NotMovingItem[]; waitingOnPerson: NotMovingItem[]; held: HeldItem[] } };
const jobs = new WeakMap<object, { last?: Stored; running?: Promise<Stored> }>();
/** Drops the stored flow so the next reader computes it again: a test that changes the ledger and reads again within the minute. */
export const forgetFlow = (key: object) => { jobs.delete(key); };
async function loadSharedFlow(key: object, now: number, compute: (now: number) => Promise<Stored>): Promise<Stored> {
  let job = jobs.get(key);
  if (!job) jobs.set(key, job = {});
  if (!job.running && (!job.last || now - job.last.at >= 60_000)) {
    const own = job, running = compute(now).then(result => (own.last = result));
    own.running = running;
    running.finally(() => { if (own.running === running) own.running = undefined; }).catch(() => {});
  }
  return job.last ?? await job.running!;
}
/**
 * GY-3763: one computation per server at most once a minute, shared by every reader. A reader gets
 * the stored result with its age; one that finds it a minute old starts the next computation and
 * still answers from the stored one. Only the first read ever waits.
 */
export async function sharedFlow(key: object, now: number, compute: (now: number) => Promise<Stored>,
  visible: <T extends { id: string; key: string }>(items: T[]) => T[] = items => items): Promise<FlowReport> {
  const stored = await loadSharedFlow(key, now, compute);
  // A reporter sees only its own items: its numbers come from the stored histories, not a new read.
  const keys = new Set(visible([...stored.work]).map(item => item.key));
  const { items: _items, notMoving: _nm, waitingOnPerson: _wp, held: _held, ...flow } = keys.size === stored.work.length ? stored.flow : { ...numbers(stored.flow.items.filter(item => keys.has(item.key)), stored.at), onboarding: stored.flow.onboarding, items: [], notMoving: [], waitingOnPerson: [], held: [] };
  return { ...flow, asOf: new Date(stored.at).toISOString(), ageSeconds: Math.max(0, Math.round((now - stored.at) / 1000)) };
}
/** GY-4000: not-moving open items, human-waiting items, and held items from the same shared flow computation. */
export async function sharedNotMoving(key: object, now: number, compute: (now: number) => Promise<Stored>,
  visible: <T extends { id: string; key: string }>(items: T[]) => T[] = items => items): Promise<NotMovingReport> {
  const stored = await loadSharedFlow(key, now, compute), keys = new Set(visible([...stored.work]).map(item => item.key));
  return { notMoving: stored.flow.notMoving.filter(i => keys.has(i.key)), waitingOnPerson: stored.flow.waitingOnPerson.filter(i => keys.has(i.key)), held: stored.flow.held.filter(i => keys.has(i.key)), asOf: new Date(stored.at).toISOString(), ageSeconds: Math.max(0, Math.round((now - stored.at) / 1000)) };
}
