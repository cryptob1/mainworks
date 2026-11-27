// Concern: one alarm for any open change that has stopped moving (GY-4000) — judged by time since
// its last moving event against 3x the median of the last 50 finished items in that stage (30m..4h;
// 30m regardless when nobody owns the next step), plus the empty-board alarm (GY-3778).
import { isClosed, type Work } from '../model.js';
import { formatDuration } from '../model/duration.js';
import { parkedOnHuman } from '../model/human-request.js';
import { reworkCapHeld } from '../model/rework-ground.js';
import { unproducedManualProofs } from '../model/unproduced-attestation.js';
import type { FlowEvent } from '../flow-numbers.js';
import { actionDetailMax, storeAction, type DaemonState } from './state.js';

export const stallAlarmKey = 'stall-alarm';
/** GY-3778: at least this many free builder slots with no ready, released or releasable work for 15 minutes raise the empty-board alarm. */
const emptyBoardMinFreeSlots = 3;
const emptyBoardIdleMs = 15 * 60_000;
const emptyBoardCauseMarker = 'the line has no work to build';
export const isEmptyBoardAlarm = (detail: string) => detail.includes(emptyBoardCauseMarker);

const minStallMs = 30 * 60_000, maxStallMs = 4 * 3_600_000;
const nonMovingKinds = new Set(['heartbeat', 'github.observed', 'priority', 'message', 'taste', 'sync']);

export type NextStepOwner = 'a builder' | 'a reviewer' | 'the merge step' | 'the Lead' | 'a person' | 'nobody';
export interface NotMovingItem { key: string; title: string; stage: string; ageMs: number; owner: NextStepOwner; blocker?: string }
export interface StallReadings {
  now: number; open: readonly Work[]; ready: readonly Work[]; releasable?: readonly Work[];
  released?: number; freeSlots: number; state: Pick<DaemonState, 'actions' | 'lock'>;
}

const iso = (at: number) => new Date(at).toISOString();
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Median time spent in each stage over the last 50 finished items. */
function stageMedians(work: readonly Work[], eventsByWork: ReadonlyMap<string, readonly FlowEvent[]>): Record<string, number> {
  const finished = work.filter(item => item.stage === 'done' && !isClosed(item))
    .sort((a, b) => Date.parse(b.delivery?.mergedAt ?? b.observation?.mergedAt ?? b.stageEnteredAt) - Date.parse(a.delivery?.mergedAt ?? a.observation?.mergedAt ?? a.stageEnteredAt))
    .slice(0, 50);
  const samples = new Map<string, number[]>();
  for (const item of finished) {
    const marks = (eventsByWork.get(item.id) ?? []).filter(e => e.stage && Number.isFinite(Date.parse(e.at))).map(e => ({ at: Date.parse(e.at), stage: e.stage! })).sort((a, b) => a.at - b.at);
    const perStage = new Map<string, number>();
    for (let i = 0; i < marks.length; i++) {
      if (i > 0 && marks[i - 1]!.stage === marks[i]!.stage) continue;
      const next = marks.slice(i + 1).find(later => later.stage !== marks[i]!.stage);
      if (next && marks[i]!.stage !== 'done') perStage.set(marks[i]!.stage, (perStage.get(marks[i]!.stage) ?? 0) + Math.max(0, next.at - marks[i]!.at));
    }
    for (const [stage, dur] of perStage) samples.set(stage, [...(samples.get(stage) ?? []), dur]);
  }
  return Object.fromEntries([...samples].flatMap(([stage, list]) => { const m = median(list); return m === null ? [] : [[stage, m]]; }));
}

/** Last instant that changed an item's stage, head, session, verdict, blocker or hold. */
function lastMovedAt(item: Work, events: readonly FlowEvent[], now: number): number {
  const times: number[] = [
    item.stageEnteredAt, item.blockedAt, item.humanRequest?.at, item.candidate?.createdAt, item.lastRework?.at, item.productReview?.at, item.mergeLedger?.intentAt, item.mergeLedger?.pushedAt,
    ...(item.sessions ?? []).flatMap(s => [s.startedAt, s.endedAt, s.workTree?.at]),
    ...(item.observation?.reviews ?? []).map(r => r.submittedAt), ...(item.evidence ?? []).map(e => e.at),
  ].map(ts => Date.parse(ts ?? ''));
  let prevStage: string | null = null;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    const stageChanged = !!event.stage && prevStage !== null && event.stage !== prevStage;
    if (event.stage) prevStage = event.stage;
    if (stageChanged || !nonMovingKinds.has(event.kind)) times.push(at);
  }
  const valid = times.filter(t => Number.isFinite(t) && t <= now);
  return valid.length ? Math.max(...valid) : Math.min(Date.parse(item.createdAt) || now, now);
}

/** Who owns the next step on an open item. */
function nextStepOwner(item: Work, all: readonly Work[], now: number): NextStepOwner {
  const asks = (item.agentRequests ?? []).filter(request => request.state === 'open');
  if (parkedOnHuman(item) || asks.some(request => !!request.humanDecision || request.decider?.kind === 'human')) return 'a person';
  if (asks.some(request => (request.type as string) === 'scope-request')) return 'the Lead';
  const awaitingSignoff = item.stage === 'acceptance' && Array.isArray(item.gates) && Array.isArray(item.criteria) && Array.isArray(item.violations) && unproducedManualProofs(item, [...all], new Date(now)).length > 0;
  if (!item.criteria?.length || item.hold || reworkCapHeld(item) || awaitingSignoff) return 'the Lead';
  const sessions = (item.sessions ?? []).filter(s => s.state === 'running');
  const backedOff = (item.actionQueue?.actions ?? []).some(a => a.state === 'pending' && !!a.retryAt && Date.parse(a.retryAt) <= now && !(a.claim && Date.parse(a.claim.expiresAt) > now));
  if ((backedOff || item.blocker) && !sessions.length) return 'nobody';
  // Ready work with no blocker waits in the queue for a builder slot, judged by the ready stage's usual time.
  if (sessions.some(s => s.kind === 'implementation') || item.stage === 'ready' || (!!item.lease && Date.parse(item.lease.expiresAt) > now && item.stage === 'build')) return 'a builder';
  if (item.stage === 'review') return sessions.some(s => s.kind === 'review') ? 'a reviewer' : 'nobody';
  return item.stage === 'test' || item.stage === 'merge' || item.stage === 'acceptance' ? 'the merge step' : 'nobody';
}

/** Derive not-moving open items and items waiting on a person (listed separately), oldest first. */
export function deriveNotMoving(work: readonly Work[], now: number, eventsByWork: ReadonlyMap<string, readonly FlowEvent[]> = new Map()): { notMoving: NotMovingItem[]; waitingOnPerson: NotMovingItem[] } {
  const medians = stageMedians(work, eventsByWork), notMoving: NotMovingItem[] = [], waitingOnPerson: NotMovingItem[] = [];
  for (const item of work) {
    // Work waiting on an open dependency is not itself stalled: the dependency is, and is reported.
    if (item.stage === 'done' || isClosed(item) || (!item.ready && item.stage === 'backlog') || item.dependencies?.some(id => work.find(dep => dep.id === id)?.stage !== 'done')) continue;
    const owner = nextStepOwner(item, work, now), ageMs = Math.max(0, now - lastMovedAt(item, eventsByWork.get(item.id) ?? [], now));
    const entry: NotMovingItem = { key: item.key, title: item.title, stage: item.stage, ageMs, owner, ...(item.blocker ? { blocker: item.blocker } : {}) };
    if (owner === 'a person') { waitingOnPerson.push(entry); continue; }
    const thresholdMs = owner === 'nobody' ? minStallMs : Math.min(maxStallMs, Math.max(minStallMs, 3 * (medians[item.stage] ?? 0)));
    if (ageMs > thresholdMs) notMoving.push(entry);
  }
  const oldestFirst = (a: NotMovingItem, b: NotMovingItem) => b.ageMs - a.ageMs || a.key.localeCompare(b.key);
  return { notMoving: notMoving.sort(oldestFirst), waitingOnPerson: waitingOnPerson.sort(oldestFirst) };
}

export const formatNotMovingLine = (item: NotMovingItem) =>
  `${item.key} ${item.title.length > 50 ? `${item.title.slice(0, 49)}…` : item.title} — ${formatDuration(item.ageMs / 60_000)} in ${item.stage}, next: ${item.owner}`;
export const formatNotMovingLines = (items: readonly NotMovingItem[]) =>
  items.length ? [...items.slice(0, 5).map(formatNotMovingLine), ...(items.length > 5 ? [`+${items.length - 5} more not moving`] : [])] : [];

/** GY-3778: the newest builder start (running implementation session or completed dispatch), else the loop's own start. */
function lastBuilderStartAt(state: StallReadings['state'], work: readonly Work[]): number | null {
  const times: number[] = [];
  for (const item of work) for (const session of item.sessions ?? []) {
    if (session.kind === 'implementation' && session.state === 'running') times.push(Date.parse(session.startedAt ?? ''));
  }
  for (const [key, action] of Object.entries(state.actions)) if (key.startsWith('dispatch:') && action.state === 'done') times.push(Date.parse(action.at));
  const seen = times.filter(Number.isFinite);
  return seen.length ? Math.max(...seen) : state.lock ? Date.parse(state.lock.startedAt) : null;
}

/** GY-3778: the empty-board alarm — free builder slots sitting idle with nothing ready, released or releasable for 15 minutes. */
export function stallAlarm(readings: StallReadings): string | null {
  const { now, open, ready, freeSlots, state } = readings;
  const hasWork = ready.length > 0 || (readings.released ?? open.filter(item => item.ready && item.stage !== 'done').length) > 0 || (readings.releasable?.length ?? 0) > 0;
  const lastStart = lastBuilderStartAt(state, open);
  if (!hasWork && freeSlots >= emptyBoardMinFreeSlots && lastStart !== null && now - lastStart >= emptyBoardIdleMs)
    return `Stall: ${freeSlots} free builder slot(s) and no ready, released or releasable work since ${iso(lastStart)}. Cause: ${emptyBoardCauseMarker} (${freeSlots} free builder slot(s)).`;
  return null;
}

/** GY-3835: when the current empty-board alarm first fired, or null when no empty-board alarm stands. */
export function emptyBoardAlarmSince(state: Pick<DaemonState, 'actions'>): number | null {
  const standing = state.actions[stallAlarmKey];
  if (!standing || !isEmptyBoardAlarm(standing.detail)) return null;
  const at = Date.parse(standing.since ?? standing.at);
  return Number.isFinite(at) ? at : null;
}

/** Raises, updates or clears the empty-board alarm's one cursor entry; the master is woken by masterCauses. */
export function recordStallAlarm(state: DaemonState, text: string | null, now: number) {
  const standing = state.actions[stallAlarmKey];
  if (!text) { if (standing) delete state.actions[stallAlarmKey]; return !!standing; }
  const detail = text.slice(0, actionDetailMax);
  if (standing?.detail === detail) return false;
  const at = iso(now);
  const since = isEmptyBoardAlarm(detail)
    ? (standing && isEmptyBoardAlarm(standing.detail) ? (standing.since ?? standing.at) : at)
    : undefined;
  storeAction(state, stallAlarmKey, { kind: 'attention', work: null, principal: null, state: 'failed', detail, attempts: 1, epoch: null, cycle: state.cycle, at, ...(since ? { since } : {}) });
  return true;
}
