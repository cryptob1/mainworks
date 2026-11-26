// Concern: GY-3835, GY-3865 — when ready or released-and-unclaimed work drops to two or fewer items
// with free builder slots (or the empty-board alarm holds for 30 minutes) and no planner draft was
// filed in the last 2 hours, launch one headless planner session to draft up to three unreleased
// items with why and simplest only for the Lead to sharpen or close.
import type { Cycle } from './cycle.js';
import { emptyBoardAlarmSince } from './stall-alarm.js';
import type { Work } from '../model/work.js';
import { percent, reworkCauses, type FlowNumbers } from '../flow-numbers.js';
import { readTestSelections, testSelectionSummary } from '../merge-writer/test-selection.js';
import { readTrialTimings, slowestTrialFiles } from '../merge-writer/trial-timings.js';

const plannerHoldMs = 30 * 60_000;
const plannerCooldownMs = 2 * 60 * 60_000;
const plannerRetryMs = 30 * 60_000;
const plannerMaxBackoffMs = 24 * 60 * 60_000;
const deliveredWindowMs = 7 * 24 * 60 * 60 * 1000;
const plannerKey = 'planner';
const maxPlannerDrafts = 3;
const plannerLowWater = 2;

export interface PlannerDraft {
  title: string;
  why: string;
  simplest: string;
  goal?: string;
  type?: 'feature' | 'bug' | 'chore';
  priority?: number;
}

export interface PlannerInput {
  brief: string | null;
  openTitles: string[];
  deliveredTitles?: string[];
  closedDrafts?: string[];
}

export type PlannerOutcome = { skipped: string } | { filed: string[]; result: string };

const isPlannerDraft = (item: Pick<Work, 'origin'>) => item.origin === 'planner';

const isReadyOrReleasedUnclaimed = (item: Work, now: number) =>
  item.stage !== 'done'
  && (item.owner ?? null) === null
  && (item.stage === 'ready' || item.ready)
  && !item.blocker
  && !item.hold
  && !(item.submission && !item.reworkRequested)
  && !(item.lease && Date.parse(item.lease.expiresAt) > now)
  && !(item.sessions ?? []).some(session => session.kind === 'implementation' && session.state === 'running');

/** GY-3835: open unreleased planner drafts awaiting criteria from the Lead. */
export function plannerDraftAttention(open: readonly Work[]) {
  return open
    .filter(item => item.stage !== 'done' && isPlannerDraft(item) && !item.ready && !item.criteria.length)
    .map(item => ({
      subject: item.key,
      text: `Planner draft awaiting Lead review (${item.key}): ${item.title}`,
      next: `Write criteria (mainworks master requirements ${item.key} FILE REASON) or close (mainworks master close ${item.key} REASON)`,
    }));
}

/** GY-3838: the five slowest trial test files over the last 20 stored merge trials and release checks, by median seconds. */
export const slowestTrialTestFiles = (root: string): { file: string; seconds: number }[] =>
  slowestTrialFiles(readTrialTimings(root)).map(entry => ({ file: entry.file, seconds: entry.medianSeconds }));

export type PlannerTestSelection = ReturnType<typeof testSelectionSummary>;

/** GY-3845: median testSelection shares over the last 20 item trials. */
export const plannerTestSelection = (root: string): PlannerTestSelection =>
  testSelectionSummary(readTestSelections(root));

const deliveredAt = (item: Pick<Work, 'delivery' | 'observation' | 'stageEnteredAt' | 'updatedAt'>) =>
  Date.parse(item.delivery?.mergedAt ?? item.observation?.mergedAt ?? item.stageEnteredAt ?? item.updatedAt);

/** GY-3845: keys and titles of items delivered in the last seven days, newest first. */
export function recentlyDeliveredTitles(work: readonly Work[], now: number): string[] {
  return work
    .filter(item => {
      if (item.stage !== 'done' || item.closure) return false;
      const at = deliveredAt(item);
      return Number.isFinite(at) && now - at <= deliveredWindowMs;
    })
    .sort((a, b) => deliveredAt(b) - deliveredAt(a))
    .map(item => `${item.key}: ${item.title}`);
}

const closedAt = (item: Pick<Work, 'closure' | 'stageEnteredAt' | 'updatedAt'>) =>
  Date.parse(item.closure?.at ?? item.stageEnteredAt ?? item.updatedAt);

/** GY-3911: planner-origin drafts closed in the last seven days with their close reasons, newest first. */
export function recentlyClosedDrafts(work: readonly Work[], now: number): string[] {
  return work
    .filter(item => {
      if (!isPlannerDraft(item) || item.stage !== 'done' || !item.closure) return false;
      const at = closedAt(item);
      return Number.isFinite(at) && now - at <= deliveredWindowMs;
    })
    .sort((a, b) => closedAt(b) - closedAt(a))
    .map(item => {
      const reason = item.closure!.reason.trim();
      return reason ? `${item.key}: ${item.title} — ${reason}` : `${item.key}: ${item.title}`;
    });
}

/** Builds the headless planner prompt from the product brief, 6-hour flow numbers, rework causes, testSelection shares, five slowest trial test files, open items, recently delivered items and recently closed planner drafts. */
export function plannerPrompt(context: {
  brief: string | null;
  flow6h: FlowNumbers | null;
  slowestTrialFiles: readonly { file: string; seconds: number }[];
  testSelection?: PlannerTestSelection;
  openTitles: readonly string[];
  deliveredTitles?: readonly string[];
  closedDrafts?: readonly string[];
}): string {
  const flowLines = context.flow6h
    ? [
        `6-hour flow: ${context.flow6h.mergesPerHour.toFixed(1)} merges/h (${context.flow6h.merges} merges), ${context.flow6h.attemptsPerHour.toFixed(1)} attempts/h (${context.flow6h.attempts} attempts), first-pass yield ${percent(context.flow6h.firstPassYield)}, trials ${context.flow6h.trials}, flaky ${context.flow6h.flaky} (${percent(context.flow6h.flakyRate)}), reverts ${context.flow6h.reverts}.`,
        `Rework causes (6h): ${reworkCauses.map(cause => `${cause}: ${context.flow6h!.rework[cause] ?? 0}`).join(', ')}.`,
        ...(context.flow6h.trialFailures?.length ? [`Failing checks (6h): ${context.flow6h.trialFailures.map(failing => `${failing.check} ${failing.count}${failing.assertion ? ` (${failing.assertion})` : ''}`).join('; ')}.`] : []),
        ...(context.flow6h.flakyChecks?.length ? [`Flaky checks (6h): ${context.flow6h.flakyChecks.map(flaky => `${flaky.check} ${flaky.count}${flaky.assertion ? ` (${flaky.assertion})` : ''}`).join('; ')}.`] : []),
      ]
    : ['6-hour flow: unavailable.', 'Rework causes (6h): unavailable.'];

  const selectionLine = context.testSelection
    ? `Test selection (last ${context.testSelection.trials} trials): median ${context.testSelection.medianShareSelected} of reachable, ${context.testSelection.medianShareOfAllSelected ?? 'unavailable'} of all tests.`
    : 'Test selection: unavailable (median share of reachable and of all tests).';

  const slowLines = context.slowestTrialFiles.length
    ? context.slowestTrialFiles.slice(0, 5).map((entry, index) => `${index + 1}. ${entry.file} (${entry.seconds}s)`)
    : ['(no trial timing data available)'];

  const openSection = context.openTitles.length
    ? ['', 'Currently open items (do not duplicate):', ...context.openTitles.slice(0, 20).map(title => `- ${title}`)]
    : [];

  const deliveredSection = context.deliveredTitles?.length
    ? ['', 'Delivered in the last 7 days (do not redraft):', ...context.deliveredTitles.map(title => `- ${title}`)]
    : [];

  const closedSection = context.closedDrafts?.length
    ? ['', 'Planner drafts closed in the last 7 days (do not re-propose):', ...context.closedDrafts.map(entry => `- ${entry}`)]
    : [];

  return [
    'You are a headless planner session. Ready work is low or empty while builder slots are free.',
    'Draft at most 3 small, high-leverage work items from the product brief, 6-hour flow numbers, rework causes and slowest trial test files for the Lead to sharpen and release.',
    'Respond with ONLY a JSON array of 1 to 3 objects. Each object must have:',
    '- "title": short imperative title (max 200 chars)',
    '- "why": one sentence on how it helps users (max 300 chars)',
    '- "simplest": one sentence on why it is the simplest thing that works (max 300 chars)',
    '- optional "goal" (short string), "type" ("feature" | "bug" | "chore"), "priority" (0-4)',
    'Do NOT include criteria or release instructions; the Lead writes criteria and releases.',
    '',
    'Product brief:',
    context.brief?.trim() || '(no product brief recorded)',
    '',
    ...flowLines,
    selectionLine,
    '',
    'Five slowest trial test files:',
    ...slowLines,
    ...openSection,
    ...deliveredSection,
    ...closedSection,
  ].join('\n');
}

const cleanText = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';

/** Parses at most three valid drafts (title, why, simplest; no criteria) from the planner session's output. */
export function parsePlannerDrafts(output: string): PlannerDraft[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const candidates: string[] = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const bracketStart = trimmed.indexOf('[');
  const bracketEnd = trimmed.lastIndexOf(']');
  if (bracketStart >= 0 && bracketEnd > bracketStart) candidates.push(trimmed.slice(bracketStart, bracketEnd + 1));

  let parsed: unknown = null;
  for (const text of candidates) {
    try { parsed = JSON.parse(text); break; } catch { /* try next candidate */ }
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { drafts?: unknown }).drafts)
      ? (parsed as { drafts: unknown[] }).drafts
      : [];

  const drafts: PlannerDraft[] = [];
  for (const row of rows) {
    if (drafts.length >= maxPlannerDrafts) break;
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const title = cleanText(entry.title, 200);
    const why = cleanText(entry.why, 300);
    const simplest = cleanText(entry.simplest, 300);
    if (!title || !why || !simplest) continue;
    const goal = cleanText(entry.goal, 120);
    const type = entry.type === 'feature' || entry.type === 'bug' || entry.type === 'chore' ? entry.type : undefined;
    const priority = typeof entry.priority === 'number' && Number.isInteger(entry.priority) && entry.priority >= 0 && entry.priority <= 4 ? entry.priority : undefined;
    drafts.push({ title, why, simplest, ...(goal ? { goal } : {}), ...(type ? { type } : {}), ...(priority !== undefined ? { priority } : {}) });
  }
  return drafts;
}

/**
 * Starts one headless planner session beside the cycle when two or fewer items are ready or
 * released-and-unclaimed while builder slots are free (or the empty-board alarm has held for
 * 30 minutes) and no planner draft has been filed in the last 2 hours.
 */
export function plannerStep(
  cycle: Pick<Cycle, 'config' | 'state' | 'effects' | 'snapshot' | 'clock' | 'launcher' | 'log'>,
  options?: { freeSlots?: number },
) {
  const { config, state, effects, snapshot, clock, launcher, log } = cycle;
  const start = effects.planner;
  if (!start || config.forPerson || config.run.planner?.enabled === false || launcher.busy(plannerKey)) return;
  const alarmSince = emptyBoardAlarmSince(state);
  const emptyBoardDue = alarmSince !== null && clock - alarmSince >= plannerHoldMs;
  const running = snapshot.work.flatMap(item => item.sessions ?? []).filter(session => session.kind === 'implementation' && session.state === 'running').length;
  const freeSlots = options?.freeSlots ?? (config.workers.length - running);
  const readyCount = snapshot.work.filter(item => isReadyOrReleasedUnclaimed(item, clock)).length;
  const lowWaterDue = freeSlots > 0 && readyCount <= plannerLowWater;
  if (!emptyBoardDue && !lowWaterDue) return;

  const recentDraft = snapshot.work.some(item => {
    if (!isPlannerDraft(item)) return false;
    const created = Date.parse(item.createdAt);
    return Number.isFinite(created) && clock - created < plannerCooldownMs;
  });
  if (recentDraft) return;
  if (state.planner?.filedAt && clock - Date.parse(state.planner.filedAt) < plannerCooldownMs) return;
  if (state.planner?.nextAt && clock < Date.parse(state.planner.nextAt)) return;
  if (state.planner?.at && clock - Date.parse(state.planner.at) < plannerRetryMs) return;

  const at = new Date(clock).toISOString();
  const brief = state.projectMemory.brief?.markdown ?? null;
  const openTitles = snapshot.work.filter(item => item.stage !== 'done').map(item => `${item.key}: ${item.title}`);
  const deliveredTitles = recentlyDeliveredTitles(snapshot.work, clock);
  const closedDrafts = recentlyClosedDrafts(snapshot.work, clock);
  const priorFiledAt = state.planner?.filedAt ?? null;
  const priorFailures = state.planner?.failures ?? 0;
  state.planner = { at, filedAt: priorFiledAt, result: 'Running', failures: priorFailures, nextAt: state.planner?.nextAt ?? null };

  launcher.submit(plannerKey, [], async () => {
    let failed = false;
    const outcome = await start({ brief, openTitles, deliveredTitles, closedDrafts }).catch((error: unknown): PlannerOutcome => {
      failed = true;
      return {
        filed: [],
        result: `Failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    });
    const filed = 'filed' in outcome ? outcome.filed : [];
    const result = ('skipped' in outcome ? `Skipped: ${outcome.skipped}` : outcome.result).slice(0, 500);
    const failures = failed ? priorFailures + 1 : 0;
    const backoffMs = failed ? Math.min(plannerMaxBackoffMs, plannerCooldownMs * 2 ** Math.min(failures - 1, 10)) : 0;
    const nextAt = failed ? new Date(clock + backoffMs).toISOString() : null;
    state.planner = { at, filedAt: filed.length ? at : priorFiledAt, result, failures, nextAt };
    log(`[mainworks-master] cycle ${state.cycle}: planner ${result}`);
    await effects.persist(state).catch(() => {});
  });
}
