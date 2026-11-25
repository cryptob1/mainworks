// Concern: GY-3624 flow numbers — attempts and merges an hour, first-pass yield with rework causes, wait per station, flaky rate and reverts, for a window, from item histories and trial ledgers. Nothing is stored.
import { plainDuration, spread } from './pipeline-speed.js';
import { mergeWriterTrialGround } from './model/rework-ground.js';
import { trialAheadOfReviewPrefix } from './model/merge-queue.js';

export const flowWindows = { '6h': 6, '24h': 24, '7d': 168 } as const;
export type FlowWindow = keyof typeof flowWindows;
export const flowStations = ['ready', 'build', 'review', 'test queue', 'merge trial', 'acceptance', 'waiting for sign-off', 'waiting for the merge writer', 'merge', 'live'] as const;
type FlowStation = typeof flowStations[number];
export const reworkCauses = ['review', 'product review', 'merge trial', 'acceptance', 'base moved', 'red base'] as const;
type ReworkCause = typeof reworkCauses[number];

/**
 * One ledger row as the flow reads it: a row carrying the item's whole document names its `stage`;
 * a `rework` its reason and ground; a `merge.trial` its head, how long it ran (it is recorded when it
 * ends) and whether it flaked (its failing tests passed on the rerun, or failed the same way on the
 * base); a `merge.serve-revert` whether it reverted.
 */
export interface FlowEvent { kind: string; at: string; stage?: string | null; reason?: string | null; binding?: string | null; head?: string | null; durationMs?: number | null; flaky?: boolean; reverted?: boolean }
export interface FlowItem {
  key: string; title: string; stage: string; stageEnteredAt: string; mergedAt: string | null;
  /** First serving deploy containing this merge (`null` when deploy records exist and none contains it yet; `undefined` when deploy tracking is unavailable). */
  deployedAt?: string | null;
  /** GY-3770: true when this open item in acceptance currently waits only on Lead-attestable manual proofs. */
  awaitingSignoff?: boolean;
  attempts: { claimedAt: string; endedAt: string | null; end: string | null }[];
  events: FlowEvent[];
}
interface StationWait { median: number; p90: number; samples: number; oldest: { key: string; title: string; minutes: number; waiting: boolean } }
export interface FlowNumbers {
  hours: number; attempts: number; attemptsPerHour: number; merges: number; mergesPerHour: number;
  /** Attempts merged with no rework request ÷ attempts ended; null when none ended. */
  firstPassYield: number | null;
  rework: Record<ReworkCause, number>;
  /** GY-3839: the top three short reasons review and product review sent heads back for, read from each verdict's first BLOCKING line. */
  reviewReasons: { label: string; count: number }[];
  stations: Record<FlowStation, StationWait | null>;
  trials: number; flaky: number; flakyRate: number | null;
  reverts: number; revertRate: number | null;
}

/** Which station sent the head back, read from the rework's reason and the ground it binds. */
function reworkCause(reason: string, binding: string | null | undefined): ReworkCause {
  const ground = binding ?? '';
  if (/:conflict$|:sync:/.test(ground) || /merge conflicts in|The base moved/.test(reason)) return 'base moved';
  if (/base failure|on the base tip too/i.test(reason)) return 'red base';
  if (ground.endsWith(`:${mergeWriterTrialGround}`)) return 'merge trial';
  if (/:proof|:human:/.test(ground)) return 'acceptance';
  if (/product review/.test(reason)) return 'product review';
  return 'review';
}

/** GY-3839: a short label for a review's first BLOCKING finding, past its `PATH:LINE — ` or `SCREEN — ` prefix (hyphen, en or em dash). */
function reviewReason(reason: string): string {
  const line = /BLOCKING:?\s*(.*)/.exec(reason)?.[1] ?? '';
  const prefix = /\s[-–—]\s/.exec(line);
  const finding = prefix ? line.slice(prefix.index + prefix[0].length) : line;
  if (/regress|no longer|used to/i.test(finding)) return 'regression';
  if (/\b(tests?|proofs?)\b/i.test(finding)) return 'missing test';
  if (/criteri|\bAC-\d|not met|unmet|requirement/i.test(finding)) return 'criterion unmet';
  if (/\bUI\b|page|screen|layout|overflow|button|scroll|\d+ ?px|render|display|click/i.test(finding)) return 'UI defect';
  return 'other';
}

const ms = (iso: string | null | undefined) => iso ? Date.parse(iso) : Number.NaN;
const stationOf: Record<string, FlowStation> = { ready: 'ready', build: 'build', review: 'review', acceptance: 'acceptance', merge: 'merge' };
const isSignoffRefusal = (event: FlowEvent) => event.kind === 'merge.refused'
  && !!event.reason?.startsWith(trialAheadOfReviewPrefix)
  && /acceptance gate awaits .*manual:/.test(event.reason);
interface Visit { station: FlowStation; start: number; end: number; open: boolean }

/**
 * The item's stays at each station, from the stage each whole-document row records. A merge trial is
 * timed by its own run: the intent it records moves the item out of test in the instant it passes,
 * so the test stage is the queue until the item's first trial in it starts.
 */
function visits(item: FlowItem, now: number): Visit[] {
  // The item's current stage holds from its stageEnteredAt on, whatever the rows after it record.
  const entered = ms(item.stageEnteredAt);
  const marks = [...item.events.filter(event => event.stage && ms(event.at) < entered).map(event => ({ at: ms(event.at), stage: event.stage! })), { at: entered, stage: item.stage }]
    .filter(mark => Number.isFinite(mark.at)).sort((a, b) => a.at - b.at);
  const trials: Visit[] = item.events.filter(event => event.kind === 'merge.trial' && Number.isFinite(ms(event.at)))
    .map(event => ({ station: 'merge trial', start: ms(event.at) - (event.durationMs ?? 0), end: ms(event.at), open: false }));
  const out: Visit[] = [...trials];
  marks.forEach((mark, index) => {
    if (index > 0 && marks[index - 1].stage === mark.stage) return;
    const next = marks.slice(index + 1).find(later => later.stage !== mark.stage);
    const end = next ? next.at : now, open = !next;
    if (mark.stage === 'test') {
      const started = trials.filter(trial => trial.end >= mark.at && trial.start < end).map(trial => Math.max(trial.start, mark.at));
      out.push(started.length ? { station: 'test queue', start: mark.at, end: Math.min(...started), open: false } : { station: 'test queue', start: mark.at, end, open });
    } else if (mark.stage === 'acceptance') {
      out.push({ station: 'acceptance', start: mark.at, end, open });
      // GY-3770: split acceptance wait into waiting for sign-off vs waiting for the merge writer.
      const split = item.events.filter(event => isSignoffRefusal(event) && ms(event.at) >= mark.at && ms(event.at) < end).map(event => ms(event.at)).sort((a, b) => a - b)[0];
      if (split !== undefined) {
        if (split > mark.at) out.push({ station: 'waiting for the merge writer', start: mark.at, end: split, open: false });
        out.push({ station: 'waiting for sign-off', start: split, end, open });
      } else {
        const prior = item.events.filter(event => (event.kind === 'merge.refused' || event.kind === 'merge.intent') && ms(event.at) <= mark.at).sort((a, b) => ms(a.at) - ms(b.at)).at(-1);
        const signoff = (open && !!item.awaitingSignoff) || (!!prior && isSignoffRefusal(prior));
        out.push({ station: signoff ? 'waiting for sign-off' : 'waiting for the merge writer', start: mark.at, end, open });
      }
    } else if (stationOf[mark.stage]) out.push({ station: stationOf[mark.stage], start: mark.at, end, open });
  });
  const merged = ms(item.mergedAt);
  if (Number.isFinite(merged) && item.deployedAt !== undefined) {
    const deployed = ms(item.deployedAt);
    out.push(Number.isFinite(deployed)
      ? { station: 'live', start: merged, end: Math.max(merged, deployed), open: false }
      : { station: 'live', start: merged, end: now, open: true });
  }
  return out;
}

/** How each attempt ended, and when: reworked (with the cause), abandoned, merged, or not yet. */
function attemptOutcomes(item: FlowItem) {
  const reworks = item.events.filter(event => event.kind === 'rework');
  const merged = ms(item.mergedAt);
  return item.attempts.flatMap((attempt, index) => {
    const from = ms(attempt.claimedAt), to = index + 1 < item.attempts.length ? ms(item.attempts[index + 1].claimedAt) : Infinity;
    const rework = reworks.find(event => ms(event.at) >= from && ms(event.at) < to);
    if (rework) return [{ at: ms(rework.at), merged: false }];
    if (attempt.end === 'released' || attempt.end === 'expired') return [{ at: ms(attempt.endedAt), merged: false }];
    if (to === Infinity && merged >= from) return [{ at: merged, merged: true }];
    return [];
  });
}

/** The flow over the `hours` before `now`. */
export function flowNumbers(items: readonly FlowItem[], hours: number, now: number): FlowNumbers {
  const from = now - hours * 3_600_000, inWindow = (at: number) => at > from && at <= now;
  const ended = items.flatMap(attemptOutcomes).filter(outcome => inWindow(outcome.at));
  const merges = items.filter(item => inWindow(ms(item.mergedAt))).length;
  const events = items.flatMap(item => item.events.filter(event => inWindow(ms(event.at))));
  const rework = Object.fromEntries(reworkCauses.map(cause => [cause, 0])) as Record<ReworkCause, number>;
  const reasons = new Map<string, number>();
  for (const event of events) if (event.kind === 'rework') {
    const cause = reworkCause(event.reason ?? '', event.binding);
    rework[cause] += 1;
    if (cause === 'review' || cause === 'product review') { const label = reviewReason(event.reason ?? ''); reasons.set(label, (reasons.get(label) ?? 0) + 1); }
  }
  const reviewReasons = [...reasons].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 3);
  // GY-3732: like merges an hour, the live station counts only merges made inside the window.
  const stays = items.flatMap(item => visits(item, now).filter(visit => visit.station === 'live' ? inWindow(visit.start) : visit.end > from).map(visit => ({ item, visit, ms: visit.end - visit.start })));
  const stations = Object.fromEntries(flowStations.map(station => {
    const here = stays.filter(stay => stay.visit.station === station);
    const wait = spread(here.map(stay => stay.ms));
    if (!wait) return [station, null];
    // The item waiting there longest now, else the longest stay the window saw.
    const longest = (list: typeof here) => list.reduce((a, b) => b.ms > a.ms ? b : a);
    const waiting = here.filter(stay => stay.visit.open);
    const oldest = longest(waiting.length ? waiting : here);
    return [station, { ...wait, oldest: { key: oldest.item.key, title: oldest.item.title, minutes: Math.round(oldest.ms / 60_000), waiting: oldest.visit.open } }];
  })) as Record<FlowStation, StationWait | null>;
  const trials = events.filter(event => event.kind === 'merge.trial'), flaky = trials.filter(event => event.flaky).length;
  const reverts = events.filter(event => event.kind === 'merge.serve-revert' && event.reverted).length;
  const ratio = (part: number, whole: number) => whole ? part / whole : null;
  return {
    hours, attempts: ended.length, attemptsPerHour: ended.length / hours, merges, mergesPerHour: merges / hours,
    firstPassYield: ratio(ended.filter(outcome => outcome.merged).length, ended.length), rework, reviewReasons, stations,
    trials: trials.length, flaky, flakyRate: ratio(flaky, trials.length), reverts, revertRate: ratio(reverts, merges),
  };
}

const capital = (text: string) => text[0].toUpperCase() + text.slice(1);
const windowWords = (hours: number) => hours === 168 ? '7 days' : `${hours} hours`;
/** One attention line when a station's slowest tenth waited over an hour: the slowest such station and its oldest item. */
export function flowAttention(flow: FlowNumbers): { subject: string; text: string; next: string } | null {
  const slow = flowStations.flatMap(station => flow.stations[station] && flow.stations[station]!.p90 > 60 ? [{ station, wait: flow.stations[station]! }] : [])
    .sort((a, b) => b.wait.p90 - a.wait.p90)[0];
  if (!slow) return null;
  const { oldest } = slow.wait;
  return { subject: slow.station,
    text: `${capital(slow.station)} is slow: the slowest tenth waited ${plainDuration(slow.wait.p90)} over the last ${windowWords(flow.hours)}. ${oldest.waiting ? 'Oldest' : 'Longest'}: ${oldest.key} ${oldest.title}, ${plainDuration(oldest.minutes)}.`,
    next: `mainworks status ${oldest.key}` };
}

/** "75%", or a dash when nothing ended. */
export const percent = (fraction: number | null) => fraction === null ? '—' : `${Math.round(fraction * 100)}%`;
