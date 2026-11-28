// Concern: the GitHub API calls the loop makes in an hour (GY-4070) — counted by source on the cursor,
// the limit remaining as GitHub's response headers report it, and the slowdown of observation polling
// once the calls reach the install's share of the hourly limit.
import { setTimeout as delay } from 'node:timers/promises';
import type { DaemonState } from './state.js';

/** Where a GitHub API call comes from: the loop's poll of the base tip, a release it publishes, or anything else (a merge push, a gh call). */
const githubCallSources = ['observation', 'releasePublish', 'other'] as const;
export type GithubCallSource = typeof githubCallSources[number];
export type GithubCalls = DaemonState['github'];

/** The percent of the hourly limit the loop may spend in an hour when master.json sets no `run.githubCallSharePercent`. */
const defaultGithubCallSharePercent = 50;
/** GitHub's hourly limit until its response headers name one: a user token's 5,000. */
const githubDefaultLimit = 5000;
/** The longest one slowed observation poll waits for the hour's calls to fall under the share. */
const githubSlowMaxWaitMs = 10_000;
/** GitHub's REST API, whose every response carries the limit in its headers. */
export const githubApiUrl = 'https://api.github.com';
const minuteMs = 60_000, hourMs = 60 * minuteMs;
const iso = (at: number) => new Date(at).toISOString();

/** The calls of the last hour by source: every minute that began less than an hour ago, whole. */
export function githubCallsInHour(calls: GithubCalls, now: number) {
  const hour = { observation: 0, releasePublish: 0, other: 0 };
  for (const minute of calls.minutes) if (minute.minute + minuteMs + hourMs > now) for (const source of githubCallSources) hour[source] += minute[source];
  return { ...hour, total: hour.observation + hour.releasePublish + hour.other };
}

/** The hourly limit the share is taken of: the one GitHub last reported, else a user token's. */
const hourlyLimit = (calls: GithubCalls) => calls.rateLimit && calls.rateLimit.limit > 0 ? calls.rateLimit.limit : githubDefaultLimit;
/** The calls an hour may hold before observation polling slows. */
const githubCallBudget = (calls: GithubCalls, sharePercent = defaultGithubCallSharePercent) => Math.floor(hourlyLimit(calls) * sharePercent / 100);

/**
 * Count one call of `source` at `now` on its minute, dropping the minutes that left the hour, and note
 * on the cursor that the hour reached the share while it stands.
 */
export function noteGithubCall(calls: GithubCalls, source: GithubCallSource, now: number, sharePercent = defaultGithubCallSharePercent) {
  calls.minutes = calls.minutes.filter(minute => minute.minute + minuteMs + hourMs > now);
  const minute = Math.floor(now / minuteMs) * minuteMs, current = calls.minutes.find(entry => entry.minute === minute);
  if (current) current[source] += 1;
  else calls.minutes = [...calls.minutes, { minute, observation: 0, releasePublish: 0, other: 0, [source]: 1 }].slice(-120);
  if (githubCallsInHour(calls, now).total >= githubCallBudget(calls, sharePercent)) calls.slowed ??= { since: iso(now), waited: 0 };
  else calls.slowed = null;
}

/**
 * How long an observation poll waits before it reaches GitHub: nothing under the share. At it, the
 * poll waits until enough of the hour's calls have aged out that it lands under the share again — the
 * oldest minutes leave the hour first, a minute an hour after it began — so polling paces itself to the
 * share however many calls the hour already holds; at most `maxWaitMs`.
 */
function githubSlowWaitMs(calls: GithubCalls, sharePercent = defaultGithubCallSharePercent, now = Date.now(), maxWaitMs = githubSlowMaxWaitMs) {
  let over = githubCallsInHour(calls, now).total - githubCallBudget(calls, sharePercent);
  if (over < 0) return 0;
  for (const minute of [...calls.minutes].sort((a, b) => a.minute - b.minute)) {
    const until = minute.minute + minuteMs + hourMs - now;
    over -= githubCallSources.reduce((sum, source) => sum + minute[source], 0);
    if (over < 0) return Math.min(Math.max(0, until), maxWaitMs);
  }
  return maxWaitMs;
}

/** The most the polls of one cycle wait together, well under a cycle step's timeout; past it a poll goes through. */
const githubStepWaitBudgetMs = 20_000;
const stepWaits = new WeakMap<GithubCalls, number>();
/** A new cycle: its polls' waits start from nothing. */
export function noteGithubCycle(calls: GithubCalls) { stepWaits.delete(calls); }

/**
 * One GitHub API call of `source`, counted on the cursor. An observation poll first waits out the
 * share (`githubSlowWaitMs`), and the wait is recorded on the cursor while it stands; a merge push
 * and a release publish are counted and never held.
 */
export async function githubCall(calls: GithubCalls, source: GithubCallSource, options: { sharePercent?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const now = options.now ?? Date.now, clock = now();
  if (source === 'observation') {
    const waited = stepWaits.get(calls) ?? 0;
    const waitMs = Math.min(githubSlowWaitMs(calls, options.sharePercent, clock), Math.max(0, githubStepWaitBudgetMs - waited));
    if (waitMs > 0) {
      calls.slowed = { since: calls.slowed?.since ?? iso(clock), waited: (calls.slowed?.waited ?? 0) + 1 };
      stepWaits.set(calls, waited + waitMs);
      await (options.sleep ?? delay)(waitMs);
    }
  }
  noteGithubCall(calls, source, now(), options.sharePercent);
}

export interface GithubRateLimit { limit: number; remaining: number; reset: string; at: string }
/**
 * GitHub's rate limit as the response headers of `GET /rate_limit` report it — a call GitHub does not
 * count against the limit. It is asked with TOKEN, the one git sends GitHub: asked without a token it
 * would report a stranger's anonymous limit. Null when GitHub did not answer it.
 */
export async function readGithubRateLimit(api: string, token: string, now: number = Date.now(), fetcher: typeof fetch = fetch): Promise<GithubRateLimit | null> {
  const response = await fetcher(`${api}/rate_limit`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response?.ok) return null;
  const header = (name: string) => { const value = response.headers.get(name); return value === null || value.trim() === '' ? Number.NaN : Number(value); };
  const limit = header('x-ratelimit-limit'), remaining = header('x-ratelimit-remaining'), reset = header('x-ratelimit-reset') * 1000;
  if (![limit, remaining, reset].every(value => Number.isFinite(value) && value >= 0)) return null;
  return { limit, remaining, reset: iso(reset), at: iso(now) };
}

/** Whether git's URL for a remote is GitHub over https, where the host's credential helper supplies the token. */
export const isGithubHttps = (url: string) => {
  try { const { protocol, hostname } = new URL(url); return protocol === 'https:' && hostname === 'github.com'; } catch { return false; }
};

export interface GithubCallsSummary {
  /** The calls of the last hour by source. */
  hour: ReturnType<typeof githubCallsInHour>;
  /** The share of the hourly limit the loop may spend, and the calls that is. */
  sharePercent: number; budget: number;
  /** The limit remaining, as GitHub's response headers last reported it. */
  rateLimit: GithubRateLimit | null;
  /** Observation polling is slowed: since when, and how many polls have waited. */
  slowed: { since: string; waited: number } | null;
  /** One plain sentence while polling is slowed. */
  detail: string | null;
}
/** What `lead status` shows of the hour's GitHub calls: the counts by source, the limit remaining, and the slowdown while the hour is at the share. */
export function githubCallsSummary(calls: GithubCalls, sharePercent = defaultGithubCallSharePercent, now = Date.now()): GithubCallsSummary {
  const hour = githubCallsInHour(calls, now), budget = githubCallBudget(calls, sharePercent);
  const slowed = hour.total >= budget ? calls.slowed ?? { since: iso(now), waited: 0 } : null;
  return { hour, sharePercent, budget, rateLimit: calls.rateLimit, slowed,
    detail: slowed ? `Observation polling is slowed: ${hour.total} GitHub API calls this hour (observation ${hour.observation}, release publish ${hour.releasePublish}, other ${hour.other}) reach this install's ${sharePercent}% share of ${hourlyLimit(calls)}.` : null };
}
