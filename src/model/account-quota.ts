// Concern: fold this account's observations and request a live check after a session signal.
import type { AgentRegistry, FleetAccount, ObservedQuota, QuotaObservation } from './registry.js';
import { parseResetTime } from './capacity.js';

export interface ProbeFailure { reason: string; resetsAt: string | null; apiError: string | null }
const probeFallbackReason = 'The live request failed';
const probeMaxLength = 160;

/**
 * GY-3788: whether a live account check failure came from the check's own environment (a read-only
 * or unwritable account home, a failed scratch home, a missing model alias in the launch, or a
 * sandbox/bwrap error) rather than from the provider or the account's login. Returns one plain line
 * naming the check's fault (at most 300 chars), or null for a real provider/account failure.
 */
export function checkEnvironmentFault(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const text = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const clip = (prefix: string) => `${prefix} (${text})`.slice(0, 300).trim();
  if (/\bEROFS\b|read-only file system|settings\.json\.lock|\b(?:EACCES|EPERM)\b|\b(?:not writable|unwritable)\b/i.test(text))
    return clip('check environment fault: read-only account home');
  if (/the smoke test's scratch home\b|mainworks-(?:agy|pi)-smoke-|\bscratch home\b.*\bfail/i.test(text))
    return clip('check environment fault: scratch home failed');
  if (/\b(?:missing|unknown|invalid)\s+model\s+alias\b|\bmodel\s+alias\b.*\b(?:not found|missing|unknown|unavailable|invalid)\b/i.test(text))
    return clip('check environment fault: missing model alias');
  if (/\bbwrap:/i.test(text))
    return clip('check environment fault: sandbox error');
  return null;
}
const jsonOpening = /\{\s*["']/;
const cliBanner = /^(?:Reading (?:additional )?(?:input|prompt) from stdin\.{0,3}|-{3,})$/i;
const cleanLine = (line: string) => line.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const sanitizePlain = (line: string): { text: string; tail: string } => {
  const idx = line.search(jsonOpening);
  if (idx >= 0) {
    const end = line.lastIndexOf('}');
    const embedded = end > idx ? extractJsonMessage(line.slice(idx, end + 1)) : extractJsonMessage(line.slice(idx));
    if (embedded?.reason) return { text: embedded.reason, tail: end > idx ? line.slice(end + 1).trim() : '' };
    const prefix = line.slice(0, idx).replace(/[:\s-]+$/, '').trim();
    return { text: prefix, tail: '' };
  }
  return { text: line, tail: '' };
};
function extractFromObject(record: unknown): { reason: string | null; apiError: string | null; isFailure: boolean } | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const obj = record as Record<string, unknown>;
  const err = obj.error && typeof obj.error === 'object' ? obj.error as Record<string, unknown> : null;
  const errData = err?.data && typeof err.data === 'object' ? err.data as Record<string, unknown> : null;
  const msg = obj.message && typeof obj.message === 'object' ? obj.message as Record<string, unknown> : null;
  const apiError = typeof obj.api_error === 'string' && obj.api_error.trim() ? obj.api_error.trim() : null;
  const isFailure = obj.is_error === true || obj.type === 'error' || obj.type === 'turn.failed' || !!apiError
    || (obj.type === 'message_end' && typeof msg?.errorMessage === 'string' && !!msg.errorMessage.trim())
    || (obj.type === 'auto_retry_end' && obj.success === false);
  const candidates = [obj.result, err?.message, errData?.message, msg?.errorMessage, obj.finalError, obj.error, obj.message];
  const raw = candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null;
  const reason = raw ? sanitizePlain(cleanLine(raw)).text : null;
  return { reason: reason || null, apiError, isFailure };
}
function extractJsonMessage(text: string): { reason: string | null; apiError: string | null; isFailure: boolean } | null {
  try { return extractFromObject(JSON.parse(text)); } catch { return null; }
}
/**
 * GY-3591: one parser for every runtime's live probe failure. Parses result/error JSON once to take
 * the provider's own sentence and reset time; falls back to the last non-empty line, cut at 160
 * characters, and never returns '{' followed by a quote.
 */
export function parseProbeFailure(
  output: string | null | undefined,
  now: number | null = null,
  parseReset: (text: string, now: number) => string | null = parseResetTime,
): ProbeFailure {
  const raw = typeof output === 'string' ? output : '';
  const trimmed = raw.trim();
  let reason: string | null = null;
  let tail = '';
  let apiError: string | null = null;
  const whole = trimmed.startsWith('{') ? extractJsonMessage(trimmed) : null;
  if (whole?.reason) {
    reason = whole.reason;
    apiError = whole.apiError;
  } else {
    const lines = raw.replace(/\r/g, '').split('\n').map(cleanLine).filter(line => Boolean(line) && !cliBanner.test(line));
    let fallbackJson: { reason: string; apiError: string | null } | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = lines[i]!.startsWith('{') ? extractJsonMessage(lines[i]!) : null;
      if (parsed?.reason) {
        if (parsed.isFailure) { reason = parsed.reason; apiError = parsed.apiError; break; }
        fallbackJson ??= { reason: parsed.reason, apiError: parsed.apiError };
      }
    }
    if (!reason && fallbackJson) { reason = fallbackJson.reason; apiError = fallbackJson.apiError; }
    if (!reason) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const cleaned = sanitizePlain(lines[i]!);
        if (cleaned.text && !jsonOpening.test(cleaned.text)) { reason = cleaned.text; tail = cleaned.tail; break; }
      }
    }
  }
  const finalReason = (reason || probeFallbackReason).slice(0, probeMaxLength).trim() || probeFallbackReason;
  // The reset time is read only against the caller's clock; without one there is no reset.
  const stated = now === null ? null : parseReset(finalReason, now) ?? (tail ? parseReset(tail, now) : null);
  const resetsAt = stated && Date.parse(stated) > now! ? stated : null;
  return { reason: finalReason, resetsAt, apiError };
}

/** An instant as the owner reads it: `2026-11-18 15:00 UTC`. */
export const utcClock = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
/** GY-3497: the sentence a limit-list window at its ceiling holds with — `Fable weekly allowance 97% used, back 2026-11-22 05:00 UTC`. */
export const allowanceHold = /^.+ allowance \d+(?:\.\d+)?% used, back \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;
/**
 * GY-3497: a window of the provider's own limit list (Claude's `limits[]`), at its ceiling with a
 * future reset, holds the account until that reset — as in usage-ceiling-holds — whatever the last
 * live check said: the provider stops sessions on that list, so the reading is the wall. A metering
 * window (five_hour/seven_day) holds nothing (GY-3555).
 */
export function windowHold(quota: QuotaObservation, ceiling: number, now: number): QuotaObservation {
  if (quota.state === 'exhausted') return quota;
  const spent = quota.usage.filter(usage => usage.limitList && usage.percent >= ceiling && !!usage.resetsAt && Date.parse(usage.resetsAt) > now)
    .sort((a, b) => Date.parse(b.resetsAt!) - Date.parse(a.resetsAt!))[0];
  if (!spent) return quota;
  const { since: _since, session: _session, ...rest } = quota;
  return { ...rest, state: 'exhausted', resetsAt: spent.resetsAt, reason: `${spent.window} allowance ${spent.percent}% used, back ${utcClock(spent.resetsAt!)}` };
}
/** A usage read that failed keeps the account's last good windows until each one's own reset, marked with when they were read (GY-3494). */
export function lastGoodUsage(account: FleetAccount, read: QuotaObservation, now: number): QuotaObservation['usage'] {
  if (read.usage.length || read.loggedIn === false) return read.usage;
  return (account.quota.usage ?? []).filter(usage => !!usage.resetsAt && Date.parse(usage.resetsAt) > now)
    .map(usage => ({ ...usage, readAt: usage.readAt ?? account.quota.observedAt ?? new Date(now).toISOString() }));
}

/**
 * What an exhausted reading rests on, named with its reset (GY-3094), or null when it rests on
 * nothing that holds (GY-3555): the account's own live request, refused by its provider; an
 * operator's mark until its reset; or a window of the provider's own limit list at its ceiling
 * (GY-3497), whose sentence names its own reset. Any other reading of exhausted is unknown. A refused live request
 * stands until a passing check.
 */
export function exhaustionEvidence(quota: Pick<ObservedQuota, 'state' | 'usage' | 'resetsAt' | 'reason' | 'session' | 'source' | 'since'>, now: number): string | null {
  if (quota.state !== 'exhausted') return null;
  // A refusal that named no reset is held for one check interval, which is not its reset (GY-3302).
  const resets = !quota.resetsAt ? 'reset unknown' : quota.session === 'guessed' ? `reset unknown, held until ${quota.resetsAt}` : `resets ${quota.resetsAt}`;
  if (quota.since) return `${quota.reason ?? 'the live request was refused'}; ${resets}`;
  if (quota.source === 'operator' && (!quota.resetsAt || Date.parse(quota.resetsAt) > now)) return `marked exhausted by an operator${quota.reason ? `: ${quota.reason}` : ''}; ${quota.resetsAt ? resets : 'awaiting a live check'}`;
  // GY-3497: a limit-list window's allowance sentence, with its reset still ahead, is evidence the probe read.
  if (quota.resetsAt && Date.parse(quota.resetsAt) > now && allowanceHold.test(quota.reason ?? '')) return quota.reason!;
  return null;
}

/** Fold a host observation. Only a live request (since) sets quota (GY-3555): it supersedes any earlier result, and an
 * operator's mark only when it is newer than the mark. A reading that made no request never replaces a live result or a mark. */
export function foldObservation(account: FleetAccount, observed: QuotaObservation, context: { actor: string; at: string }) {
  const held = account.quota, now = Date.parse(context.at);
  // GY-3788: a check environment fault leaves the account's quota mark unchanged and records the fault once.
  if (observed.fault) {
    const loggedIn = held.loggedIn ?? observed.loggedIn;
    const changed = (held.fault ?? null) !== observed.fault || held.loggedIn !== loggedIn;
    if (changed) account.quota = { ...held, loggedIn, fault: observed.fault };
    return changed;
  }
  const decided = account.quotaDecision ? Date.parse(account.quotaDecision.at) : null;
  if (observed.since ? decided !== null && Date.parse(observed.since) <= decided : held.source === 'operator') return false;
  // A session caught on the wrong model stands until a newer live check (GY-3596).
  if (held.state === 'broken' && held.reason?.startsWith('ran on ') && held.since && (!observed.since || Date.parse(observed.since) < Date.parse(held.since))) return false;
  if (!observed.since) {
    const loginHold = held.session === 'login' && held.loggedIn === false && (!observed.identity || observed.identity === held.identity);
    if (loginHold || held.since && held.state !== 'available') return false;
  }
  // A provider restates the same reset to the millisecond or not at all; only a reset that really moved is a change.
  const moved = (held.resetsAt === null) !== (observed.resetsAt === null) || !!held.resetsAt && !!observed.resetsAt && Math.abs(Date.parse(held.resetsAt) - Date.parse(observed.resetsAt)) > 60_000;
  // A probe that could not read the login file leaves the identity last read; one that read a login naming no account (an
  // API key, a logout) clears it, so a home logged in afresh is never held under its former login.
  const identity = observed.identity === undefined ? held.identity ?? null : observed.identity;
  const state = observed.state === 'exhausted' && !exhaustionEvidence({ ...observed, source: 'probe' }, now) ? 'unknown' as const : observed.state;
  // A real live check (observed.since) clears any prior check environment fault; a passive reading keeps it.
  const fault = observed.since ? null : (held.fault ?? null);
  const changed = held.since !== observed.since || held.loggedIn !== observed.loggedIn || held.state !== state || moved || held.source !== 'probe' || identity !== (held.identity ?? null) || held.session !== observed.session || held.key !== observed.key || (held.fault ?? null) !== fault || (held.spend ?? null) !== (observed.spend ?? null);
  const { fault: _dropped, ...clean } = observed;
  account.quota = { ...clean, state, ...state === observed.state ? {} : { resetsAt: null }, ...(fault ? { fault } : {}), identity, observedAt: context.at, observedBy: context.actor, source: 'probe' };
  return changed;
}

/** A session notice requests a host check; only that request's failure can hold the account.
 * Keep an existing live failure until its check is due instead of replacing it with narrative. */
export function requestLimitNoticeCheck(registry: AgentRegistry, notice: { role: string; work: string; principal: string | null; account: string | null; reason: string; resetsAt: string | null }, context: { actor: string; at: string }) {
  const session = registry.sessions.filter(entry => entry.role === notice.role && entry.work === notice.work && (!notice.principal || entry.principal === notice.principal))
    .sort((a, b) => Date.parse(b.selectedAt) - Date.parse(a.selectedAt))[0];
  const account = registry.accounts.find(entry => entry.name === notice.account) ?? registry.accounts.find(entry => entry.name === session?.account);
  if (!account) return null;
  if (account.quota.since && account.quota.state === 'exhausted') return null;
  const observed: QuotaObservation = { loggedIn: account.quota.loggedIn, state: 'unknown', usage: account.quota.usage, resetsAt: null, session: 'guessed',
    reason: `Check ${account.name}: ${notice.reason}`.slice(0, 500) };
  return foldObservation(account, observed, context) ? account.name : null;
}

/** A model id as a runtime names it: lower case, no provider prefix, no context suffix (`opus[1m]`). */
const bareModel = (id: string) => id.toLowerCase().replace(/\[[^\]]*\]$/, '').split('/').pop()!.trim();
/**
 * GY-3596: why a run that reported `ran` did not run the account's registered model `id` — `ran on X, not Y` —
 * or null when it did, reported none, or the account names no id. A runtime reports the full name of an alias
 * (`claude-opus-4-1-20250805` for `opus`) and drops a provider prefix (`glm-5.3` for `zai-coding-plan/glm-5.3`).
 */
export function wrongModel(ran: string | null | undefined, id: string | null | undefined): string | null {
  return ran && id && !bareModel(ran).includes(bareModel(id)) ? `ran on ${ran}, not ${id}` : null;
}
/** A finished session on `accountName` reported it ran on `ran`: a model other than the account's own marks it broken, as a failed live request does. */
export function recordSessionModel(registry: AgentRegistry, accountName: string | null, ran: string | null | undefined, context: { actor: string; at: string }) {
  const account = registry.accounts.find(entry => entry.name === accountName);
  const reason = account && wrongModel(ran, registry.models.find(model => model.name === account.model)?.id);
  if (!account || !reason || account.quota.state === 'broken' && account.quota.reason === reason) return false;
  account.quota = { ...account.quota, state: 'broken', reason, resetsAt: null, session: undefined, since: context.at, observedAt: context.at, observedBy: context.actor, source: 'probe' };
  return true;
}
