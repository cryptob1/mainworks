import type { Work } from './work.js';

/**
 * GY-3601: Home's incidents, from five timers over the status snapshot `/api/status` already
 * serves and the work snapshot beside it. None of them waits on an agent to report: each reads a
 * clock against a fact the control plane observes itself.
 */
export interface StatusSnapshot {
  /** The release check on main: when it began trying without a pass (batch gate), null while it is not trying. */
  releaseCheck?: { since: string } | null;
  /** Merged items the live commit does not carry yet, by key. */
  live?: { commit?: unknown; waiting?: unknown } | null;
  /** The fleet as the registry holds it: each account's roles and eligibility, each role's live sessions and limit. */
  fleet?: { accounts?: { name: string; eligible: boolean; resetsAt?: string | null; roles: { role: string }[] }[]; roles?: { role: string; live: number; limit: number }[] } | null;
  /** The test machines the loop reads; `since` is when an away machine stopped answering. */
  hosts?: { host: string; away: boolean; at?: string; since?: string }[];
  /** When the live commit was deployed. */
  app?: { deployedAt?: string | null } | null;
}

export type IncidentKind = 'release-check' | 'not-pushed' | 'accounts' | 'machine-away' | 'no-merge';
/** One card: what broke, the impact, what the team is doing, and the one action — none when it heals itself. */
export interface Incident {
  kind: IncidentKind;
  broke: string;
  impact: string;
  doing: string;
  action: { label: string; open: 'lead' | 'agents' | 'workers' | 'item'; item?: string } | null;
}

const minute = 60_000, hour = 60 * minute;
/** "28 h" or "35 min". */
export const span = (ms: number) => ms >= hour ? `${Math.floor(ms / hour)} h` : `${Math.max(1, Math.floor(ms / minute))} min`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const merged = (w: Work) => w.stage === 'done' && !w.closure && !!(w.delivery?.mergedAt ?? w.observation?.mergedAt);
const mergedAt = (w: Work) => Date.parse(w.delivery?.mergedAt ?? w.observation?.mergedAt ?? w.stageEnteredAt);
/** Tasks in flight: open items a Builder holds now. */
const inFlight = (work: Work[], now: number) => work.filter(w => w.stage !== 'done' && w.lease && Date.parse(w.lease.expiresAt) > now);
/** The worker accounts and those held or broken (not eligible to take work). */
const workerAccounts = (status: StatusSnapshot) => {
  const all = (status.fleet?.accounts ?? []).filter(account => account.roles.some(role => role.role === 'worker'));
  return { all, held: all.filter(account => !account.eligible) };
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

/** Every open incident, by the five timers. */
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
    const heals = accounts.held.every(account => account.resetsAt && Date.parse(account.resetsAt) > now);
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
