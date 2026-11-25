// Concern: GY-3835 — when the empty-board alarm holds for 30 minutes and no planner draft was filed
// in the last 2 hours, launch one headless planner session to draft up to three unreleased items
// with why and simplest only for the Lead to sharpen or close.
import type { Cycle } from './cycle.js';
import { emptyBoardAlarmSince } from './stall-alarm.js';
import type { Work } from '../model/work.js';
import { percent, reworkCauses, type FlowNumbers } from '../flow-numbers.js';
import { readTrialTimings, slowestTrialFiles } from '../merge-writer/trial-timings.js';

const plannerHoldMs = 30 * 60_000;
const plannerCooldownMs = 2 * 60 * 60_000;
const plannerRetryMs = 30 * 60_000;
const plannerMaxBackoffMs = 24 * 60 * 60_000;
const plannerKey = 'planner';
const maxPlannerDrafts = 3;

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
}

export type PlannerOutcome = { skipped: string } | { filed: string[]; result: string };

const isPlannerDraft = (item: Pick<Work, 'origin'>) => item.origin === 'planner';

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

/** Builds the headless planner prompt from the product brief, 6-hour flow numbers, rework causes and five slowest trial test files. */
export function plannerPrompt(context: {
  brief: string | null;
  flow6h: FlowNumbers | null;
  slowestTrialFiles: readonly { file: string; seconds: number }[];
  openTitles: readonly string[];
}): string {
  const flowLines = context.flow6h
    ? [
        `6-hour flow: ${context.flow6h.mergesPerHour.toFixed(1)} merges/h (${context.flow6h.merges} merges), ${context.flow6h.attemptsPerHour.toFixed(1)} attempts/h (${context.flow6h.attempts} attempts), first-pass yield ${percent(context.flow6h.firstPassYield)}, trials ${context.flow6h.trials}, flaky ${context.flow6h.flaky} (${percent(context.flow6h.flakyRate)}), reverts ${context.flow6h.reverts}.`,
        `Rework causes (6h): ${reworkCauses.map(cause => `${cause}: ${context.flow6h!.rework[cause] ?? 0}`).join(', ')}.`,
      ]
    : ['6-hour flow: unavailable.', 'Rework causes (6h): unavailable.'];

  const slowLines = context.slowestTrialFiles.length
    ? context.slowestTrialFiles.slice(0, 5).map((entry, index) => `${index + 1}. ${entry.file} (${entry.seconds}s)`)
    : ['(no trial timing data available)'];

  const openSection = context.openTitles.length
    ? ['', 'Currently open items (do not duplicate):', ...context.openTitles.slice(0, 20).map(title => `- ${title}`)]
    : [];

  return [
    'You are a headless planner session. The board has been empty for 30 minutes.',
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
    '',
    'Five slowest trial test files:',
    ...slowLines,
    ...openSection,
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
 * Starts one headless planner session beside the cycle when the empty-board alarm has held for
 * 30 minutes and no planner draft has been filed in the last 2 hours.
 */
export function plannerStep(cycle: Pick<Cycle, 'config' | 'state' | 'effects' | 'snapshot' | 'clock' | 'launcher' | 'log'>) {
  const { config, state, effects, snapshot, clock, launcher, log } = cycle;
  const start = effects.planner;
  if (!start || config.forPerson || launcher.busy(plannerKey)) return;
  const alarmSince = emptyBoardAlarmSince(state);
  if (alarmSince === null || clock - alarmSince < plannerHoldMs) return;

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
  const priorFiledAt = state.planner?.filedAt ?? null;
  const priorFailures = state.planner?.failures ?? 0;
  state.planner = { at, filedAt: priorFiledAt, result: 'Running', failures: priorFailures, nextAt: state.planner?.nextAt ?? null };

  launcher.submit(plannerKey, [], async () => {
    let failed = false;
    const outcome = await start({ brief, openTitles }).catch((error: unknown): PlannerOutcome => {
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
