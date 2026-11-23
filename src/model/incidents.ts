import type { Work } from './work.js';
import { trialRefusalHeld } from './merge-queue.js';
import { isBaseMovedRework } from './rework-ground.js';

/**
 * GY-3601: Home's incidents, from six timers (the sixth groups repeated failures, GY-3626; and the public link, GY-3690) over the status snapshot `/api/status` already
 * serves and the work snapshot beside it. None of them waits on an agent to report: each reads a
 * clock against a fact the control plane observes itself.
 */
export interface StatusAccount {
  name: string;
  enabled?: boolean;
  eligible?: boolean;
  quota?: 'available' | 'exhausted' | 'broken' | 'unknown';
  loggedIn?: boolean | null;
  smoke?: { result: 'pass' | 'fail' } | null;
  held?: { role: string }[];
  resetsAt?: string | null;
  resetUnknown?: boolean;
  roles: { role: string }[];
}

export interface StatusSnapshot {
  /** The release check on main: when it began trying without a pass (batch gate), null while it is not trying. */
  releaseCheck?: { since: string } | null;
  /** Merged items the live commit does not carry yet, by key. */
  live?: { commit?: unknown; waiting?: unknown } | null;
  /** The fleet as the registry holds it: each account's roles, health and quota, each role's live sessions and limit. */
  fleet?: { accounts?: StatusAccount[]; roles?: { role: string; live: number; limit: number }[] } | null;
  /** The test machines the loop reads; `since` is when an away machine stopped answering. */
  hosts?: { host: string; away: boolean; at?: string; since?: string }[];
  /** When the live commit was deployed. */
  app?: { deployedAt?: string | null } | null;
  /** GY-3690: while the owner turned the public link on and someone is invited but the link is not public, what the loop does and when it was last public. */
  publicLink?: { doing: string; lastPublic?: string | null } | null;
}

export type IncidentKind = 'release-check' | 'not-pushed' | 'accounts' | 'machine-away' | 'no-merge' | 'repeated-failure' | 'public-link';
/** GY-3690: the incident's and `master status`'s attention line's words. */
export const publicLinkOffLine = 'Invited people cannot open the dashboard: the public link is off although you turned it on';
/** One card: what broke, the impact, what the team is doing, and the one action — none when it heals itself. */
export interface Incident {
  kind: IncidentKind;
  broke: string;
  impact: string;
  doing: string;
  action: { label: string; open: 'lead' | 'agents' | 'workers' | 'item'; item?: string } | null;
}

const minute = 60_000, hour = 60 * minute;
/** GY-3626: three distinct items hitting the same normalised failure line within 30 minutes is one incident. */
export const repeatedFailureWindowMs = 30 * minute;
export const repeatedFailureThreshold = 3;
export interface FailureEntry { item: string; reason: string; at: string }
export interface RepeatedFailureGroup { line: string; count: number; items: string[] }

const benignSessionOutcome = /^(?:superseded:|ended:|closed by the loop:|completed\b|done\b|passed\b|approved\b|merged\b|submitted\b|the .+ runtime on .+ (?:no longer reports|reports .+ as .+, so the session is over))/i;

/** First non-empty line with item keys, UUIDs, temporary path segments, hex hashes and numbers removed. */
export function normaliseFailureLine(reason: string): string {
  const first = reason.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
  if (!first) return '';
  return first
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/(\/(?:private\/)?(?:var\/)?tmp)\/[^/\s:'")]+/g, '$1')
    .replace(/(\/\.(?:graphyard|mainworks)\/worktrees)\/[^/\s:'")]+/g, '$1')
    .replace(/(\bworktrees)\/[^/\s:'")]+/g, '$1')
    .replace(/\b[A-Z]{2,10}-\d+\b/g, '')
    .replace(/\b0x[0-9a-f]+\b/gi, '')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{4,40}\b/gi, '')
    .replace(/\b[0-9a-f]{8,40}\b/gi, '')
    .replace(/\b\d+(?:\.\d+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Group failure entries from distinct items: opens when 3+ distinct items hit the same line within 30 minutes, and stays open until 30 minutes pass with no new matching failure. */
export function groupRepeatedFailures(entries: readonly FailureEntry[], now: number, windowMs = repeatedFailureWindowMs): RepeatedFailureGroup[] {
  const byLine = new Map<string, { line: string; events: { item: string; at: number }[] }>();
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at) || now - at < -minute) continue;
    const line = normaliseFailureLine(entry.reason);
    if (!line) continue;
    const key = line.toLowerCase();
    const bucket = byLine.get(key) ?? { line, events: [] };
    bucket.events.push({ item: entry.item, at });
    byLine.set(key, bucket);
  }
  const result: RepeatedFailureGroup[] = [];
  for (const { line, events } of byLine.values()) {
    events.sort((a, b) => a.at - b.at);
    if (now - events[events.length - 1].at >= windowMs) continue;
    let start = events.length - 1;
    while (start > 0 && events[start].at - events[start - 1].at < windowMs) start--;
    const episode = events.slice(start);
    const counts = new Map<string, number>();
    let triggered = false;
    for (let left = 0, right = 0; right < episode.length; right++) {
      counts.set(episode[right].item, (counts.get(episode[right].item) ?? 0) + 1);
      while (episode[right].at - episode[left].at >= windowMs) {
        const next = (counts.get(episode[left].item) ?? 1) - 1;
        if (next <= 0) counts.delete(episode[left].item); else counts.set(episode[left].item, next);
        left++;
      }
      if (counts.size >= repeatedFailureThreshold) { triggered = true; break; }
    }
    if (!triggered) continue;
    const items = [...new Set(episode.map(event => event.item))].sort();
    result.push({ line, count: items.length, items });
  }
  return result.sort((a, b) => b.count - a.count || a.line.localeCompare(b.line));
}

/** Failed session exits and real merge-trial failures of the current head on the work snapshot; rework reasons are worker instructions, not failures. */
export function recentWorkFailures(work: readonly Work[]): FailureEntry[] {
  const entries: FailureEntry[] = [];
  for (const w of work) {
    for (const session of w.sessions ?? []) {
      const outcome = session.outcome?.trim();
      if (session.state === 'finished' && outcome && !benignSessionOutcome.test(outcome))
        entries.push({ item: w.key, reason: outcome, at: session.endedAt ?? session.updatedAt });
    }
    // Only a real trial failure of the current head, dated by its trial step or intent (never the item's updatedAt).
    const refusal = trialRefusalHeld(w.candidate, w.mergeLedger);
    const at = w.mergeLedger?.trialStep?.at ?? w.mergeLedger?.intentAt;
    if (refusal && at && !isBaseMovedRework({ binding: null, reason: refusal.reason }))
      entries.push({ item: w.key, reason: refusal.reason, at });
  }
  return entries;
}

/** Repeated-failure groups across the work snapshot within the last 30 minutes. */
export const repeatedFailureGroups = (work: readonly Work[], now: number): RepeatedFailureGroup[] =>
  groupRepeatedFailures(recentWorkFailures(work), now);

/** An open item filed for this repeated failure, if any. */
export function filedItemForFailure(work: readonly Work[], group: RepeatedFailureGroup): Work | null {
  const needle = group.line.toLowerCase();
  return work.find(w => {
    if (w.stage === 'done' || w.closure || group.items.includes(w.key)) return false;
    const text = [w.title ?? '', ...(w.description ?? '').split(/\r?\n/)];
    return text.some(line => line.toLowerCase().includes(needle) || normaliseFailureLine(line).toLowerCase().includes(needle));
  }) ?? null;
}

/** One master-status attention line per repeated-failure group. */
export function repeatedFailureAttention(work: readonly Work[], now: number) {
  return repeatedFailureGroups(work, now).map(group => {
    const filed = filedItemForFailure(work, group);
    return {
      subject: 'repeated failure',
      text: `${plural(group.count, 'item')} hit the same failure (${group.items.join(', ')}): ${group.line} — ${filed ? `filed as ${filed.key}` : 'the caretaker is looking'}`,
      next: filed ? `graphyard status ${filed.key}` : `Diagnose the shared fault (${group.items.join(', ')}) or file one hotfix item with graphyard master create FILE`,
    };
  });
}
/** "28 h" or "35 min". */
export const span = (ms: number) => ms >= hour ? `${Math.floor(ms / hour)} h` : `${Math.max(1, Math.floor(ms / minute))} min`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const merged = (w: Work) => w.stage === 'done' && !w.closure && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt);
const mergedAt = (w: Work) => Date.parse(w.delivery?.mergedAt ?? w.observation?.mergedAt ?? w.stageEnteredAt);
/** Tasks in flight: open items a Builder holds now. */
const inFlight = (work: Work[], now: number) => work.filter(w => w.stage !== 'done' && w.lease && Date.parse(w.lease.expiresAt) > now);
/** Whether an enabled worker account is held or broken — not merely busy at its session limit or disabled. */
const accountHeld = (account: StatusAccount) =>
  account.quota === 'exhausted'
  || account.quota === 'broken'
  || account.loggedIn === false
  || account.smoke?.result === 'fail'
  || !!account.held?.some(entry => entry.role === 'worker');
/** The enabled worker accounts and those held or broken. */
const workerAccounts = (status: StatusSnapshot) => {
  const all = (status.fleet?.accounts ?? []).filter(account => account.enabled !== false && account.roles.some(role => role.role === 'worker'));
  return { all, held: all.filter(accountHeld) };
};

/**
 * When the release check began trying: the first merge after the last verified commit, while a run
 * is going or the gate is held on a failure. Each run restarts, so a run's own start never shows a long wedge.
 */
export function releaseCheckSince(gate: { verifiedAt: string | null; inFlight: { startedAt: string } | null; held: { at: string } | null } | null, work: Work[]): string | null {
  if (!gate?.inFlight && !gate?.held) return null;
  const verified = gate.verifiedAt ? Date.parse(gate.verifiedAt) : Number.NEGATIVE_INFINITY;
  const since = Math.min(...work.filter(merged).map(mergedAt).filter(at => at > verified));
  // No merge after the pass: the unverified one landed while that run went, so the pass itself bounds it.
  return Number.isFinite(since) ? new Date(since).toISOString() : gate.verifiedAt ?? gate.inFlight?.startedAt ?? gate.held?.at ?? null;
}

/** GY-3690: when the install's link was last public, in words. */
export const lastPublic = (at: string | null | undefined, now: number) => at ? `It was last public ${span(now - Date.parse(at))} ago.` : 'It has not been public yet.';

/** Every open incident, by the six timers and the public link. */
export function incidentsFromStatus(status: StatusSnapshot, work: Work[], now: number): Incident[] {
  const incidents: Incident[] = [];
  const waiting = Array.isArray(status.live?.waiting) ? status.live.waiting.length : 0;

  // 1. The release check has not passed in 30 minutes of trying.
  const trying = status.releaseCheck?.since ? now - Date.parse(status.releaseCheck.since) : 0;
  if (trying >= 30 * minute) incidents.push({ kind: 'release-check', broke: `The release check has not passed in ${span(trying)}.`,
    impact: waiting ? `${plural(waiting, 'finished change')} ${waiting === 1 ? 'waits' : 'wait'} to go live.` : 'Nothing new can go live.',
    doing: 'The loop keeps retrying the same check.', action: { label: 'Ask the Lead', open: 'lead' } });

  // 2. A finished, approved head not pushed in 30 minutes.
  for (const w of work.filter(item => item.stage === 'merge' && now - Date.parse(item.stageEnteredAt) >= 30 * minute))
    incidents.push({ kind: 'not-pushed', broke: `“${w.title}” is approved but not pushed for ${span(now - Date.parse(w.stageEnteredAt))}.`,
      impact: 'Finished work is not reaching main.', doing: 'The merge writer retries the push each cycle.', action: { label: 'Open the change', open: 'item', item: w.id } });

  // 3. More than a quarter of worker accounts held or broken. Held only until a known reset heals itself.
  const accounts = workerAccounts(status);
  if (accounts.held.length * 4 > accounts.all.length) {
    const heals = accounts.held.every(account =>
      account.quota === 'exhausted'
      && account.loggedIn !== false
      && account.smoke?.result !== 'fail'
      && !account.held?.some(entry => entry.role === 'worker')
      && !account.resetUnknown
      && !!account.resetsAt
      && Date.parse(account.resetsAt) > now);
    incidents.push({ kind: 'accounts', broke: `${accounts.held.length} of ${plural(accounts.all.length, 'Builder account')} are held, so the team runs slower.`,
      impact: `${plural(inFlight(work, now).length, 'task')} in flight on the rest.`,
      doing: heals ? 'They come back on their own when their limits reset. Nothing needed.' : 'The caretaker re-tests held accounts each pass.',
      action: heals ? null : { label: 'Open accounts', open: 'agents' } });
  }

  // 4. A test machine away over 5 minutes.
  for (const host of status.hosts ?? []) {
    const away = host.away ? now - Date.parse(host.since ?? host.at ?? new Date(now).toISOString()) : 0;
    if (away >= 5 * minute) incidents.push({ kind: 'machine-away', broke: `Test machine ${host.host} has not answered for ${span(away)}.`,
      impact: 'Checks run on fewer machines and take longer.', doing: 'The loop probes it every cycle.', action: { label: 'Open machines', open: 'workers' } });
  }

  // 5. No merge in 2 hours while tasks are in flight, counted from the later of the last merge and the earliest in-flight claim.
  const flying = inFlight(work, now);
  if (flying.length) {
    const last = Math.max(...work.filter(merged).map(mergedAt), Number.NEGATIVE_INFINITY);
    const started = Math.min(...flying.map(w => Date.parse(w.lastAssignment?.claimedAt ?? w.stageEnteredAt)).filter(Number.isFinite));
    const since = Number.isFinite(started) ? Math.max(last, started) : last;
    if (Number.isFinite(since) && now - since >= 2 * hour) incidents.push({ kind: 'no-merge', broke: `Nothing has merged for ${span(now - since)}.`,
      impact: `${plural(flying.length, 'task')} in flight ${flying.length === 1 ? 'is' : 'are'} stuck.`, doing: 'Builders keep working.', action: { label: 'Ask the Lead', open: 'lead' } });
  }
  // 6. GY-3690: the owner turned the public link on and someone is invited, but the link is not public.
  if (status.publicLink) incidents.push({ kind: 'public-link', broke: `${publicLinkOffLine}.`, impact: lastPublic(status.publicLink.lastPublic, now), doing: status.publicLink.doing, action: null });

  // 7. The same normalised failure across three or more distinct items within 30 minutes (GY-3626).
  for (const group of repeatedFailureGroups(work, now)) {
    const filed = filedItemForFailure(work, group);
    incidents.push({
      kind: 'repeated-failure',
      broke: `“${group.line}” failed on ${plural(group.count, 'item')}.`,
      impact: 'Every retry stops on the same fault until it is fixed.',
      doing: filed ? `Filed as ${filed.key} (“${filed.title}”).` : 'No item filed yet — the caretaker is looking.',
      action: filed ? { label: 'Open the item', open: 'item', item: filed.id } : { label: 'Ask the Lead', open: 'lead' },
    });
  }
  return incidents;
}

/** Home's first line: state, Builders working of allowed, test machines ready of configured, time since the last change went live, merges an hour today. */
export function statusLine(status: StatusSnapshot, work: Work[], incidents: Incident[], now: number) {
  const builders = status.fleet?.roles?.find(role => role.role === 'worker');
  const hosts = status.hosts ?? [];
  const today = new Date(now).setHours(0, 0, 0, 0);
  const mergesToday = work.filter(w => merged(w) && mergedAt(w) >= today).length;
  const deployed = status.app?.deployedAt ? Date.parse(status.app.deployedAt) : null;
  const working = builders?.live ?? inFlight(work, now).length;
  return {
    state: incidents.some(incident => incident.kind === 'no-merge') ? 'Stopped' as const : incidents.length ? 'Slowed' as const : working === 0 ? 'Idle' as const : 'Moving' as const,
    builders: { working, allowed: builders?.limit ?? null },
    machines: { ready: hosts.filter(host => !host.away).length, configured: hosts.length },
    lastLive: deployed === null ? null : span(now - deployed),
    mergesPerHour: Math.round(mergesToday / Math.max(1, (now - today) / hour) * 10) / 10,
  };
}
