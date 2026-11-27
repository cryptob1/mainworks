// Concern: the hold an item's repeated limit notices on one account place (GY-1582).
import type { Work } from '../model.js';
import type { CapacityRole, ExhaustionRecord } from '../model/capacity.js';
import type { MasterConfig } from './profiles.js';
import { releasedSince, observedExhaustions, recordObservedExhaustion, type ObservedExhaustion } from './environments.js';

/**
 * How recent the last of an item's repeated limit notices on one account must be to hold it again:
 * two of the hours an account whose notice named no reset is held (`unknownResetHoldMs`), written
 * out because this module and environments.ts import each other through dispatch.ts.
 */
export const repeatedLimitWindowMs = 2 * 3_600_000;
/** How many consecutive worker launches of one item ending on one account's limit notice hold that account. */
export const repeatedLimitLaunches = 2;

/**
 * The account an item's latest launches of `role` each ended on (GY-1582, GY-1705), when the last
 * `repeatedLimitLaunches` of its quota exhaustions all name it, were recorded by consecutive launch
 * epochs (workers) or consecutive spent sessions (pane roles) ending at the item's latest, and the
 * latest is within `repeatedLimitWindowMs`. An attempt interrupted for another cause, or one that
 * ended without a limit notice (a gap), ends the run, as does one on no named account. A repeat
 * whose last notice named a reset that has since passed is over: the account has recovered, and
 * only a new notice after that reset starts another. Defaults to worker — the dispatch path.
 */
export function repeatedLimitAccount(work: Pick<Work, 'capacity'> & Partial<Pick<Work, 'epoch'>>, now = Date.now(), role: CapacityRole = 'worker'): { account: string; records: ExhaustionRecord[] } | null {
  const ofRole = (work.capacity?.exhaustions ?? []).filter(entry => entry.role === role);
  const last = ofRole.at(-1);
  if (!last?.account || (last.cause ?? 'quota') !== 'quota' || now - Date.parse(last.at) > repeatedLimitWindowMs) return null;
  if (last.resetsAt && Date.parse(last.resetsAt) <= now) return null;
  if (role === 'worker') {
    if (typeof last.epoch !== 'number') return null;
    // The item was launched again after its last notice, and that launch ended some other way.
    if (typeof work.epoch === 'number' && work.epoch !== last.epoch) return null;
    const records: ExhaustionRecord[] = [];
    for (const entry of [...ofRole].reverse()) {
      const next = records[0]?.epoch ?? last.epoch + 1;
      if (entry.epoch === next && records.length) continue; // one launch's notice reported twice is one launch
      if (entry.account !== last.account || (entry.cause ?? 'quota') !== 'quota' || entry.epoch !== next - 1) break;
      records.unshift(entry);
    }
    return records.length >= repeatedLimitLaunches ? { account: last.account, records } : null;
  }
  // Pane roles: consecutive quota exhaustions on the same account within the window, newest last.
  // Distinct sessions count even when failover reuses one request/decision id; only a duplicate
  // report of the same instant is collapsed (one session's notice reported twice).
  const records: ExhaustionRecord[] = [];
  for (const entry of [...ofRole].reverse()) {
    if (entry.account !== last.account || (entry.cause ?? 'quota') !== 'quota') break;
    if (records.some(prior => prior.at === entry.at)) continue;
    records.unshift(entry);
    if (records.length >= repeatedLimitLaunches) break;
  }
  return records.length >= repeatedLimitLaunches ? { account: last.account, records } : null;
}

/**
 * Before a launch of `work` for `role` (GY-1582, GY-1705): an account the item's consecutive
 * launches of that role each ended on with its limit notice is not chosen again. Each notice holds
 * its account as it is read, but a hold that was charged elsewhere, or lapsed on an assumed reset,
 * would let selection hand the spent account back; here it is held again, until the last notice's
 * reset or the assumed hour, so the attempt is routed to an eligible account. Workers call this from
 * dispatch; approvers from the loop's approver launch; reviewers and producers from every
 * `launchReview` / `launchProducer` (and the failover relaunch) before `selectAccount`. Returns the
 * hold placed, or null when none was needed.
 */
export async function holdRepeatedLimitAccount(config: Pick<MasterConfig, 'credentialFile'> & Partial<Pick<MasterConfig, 'environments' | 'url' | 'hostId'>>, work: Pick<Work, 'key' | 'capacity'> & Partial<Pick<Work, 'epoch'>>, now = Date.now(), report?: Parameters<typeof recordObservedExhaustion>[4], role: CapacityRole = 'worker'): Promise<{ account: string; hold: ObservedExhaustion } | null> {
  const repeated = repeatedLimitAccount(work, now, role);
  if (!repeated || (await observedExhaustions(config, now, report?.registry?.document ? { document: report.registry.document } : undefined))[repeated.account]) return null;
  const last = repeated.records.at(-1)!;
  if (await releasedSince(config, repeated.account, last.at, report?.registry?.document ? { document: report.registry.document } : undefined)) return null; // GY-3100: an operator released it after that notice
  const launches = role === 'worker'
    ? `worker launches (epochs ${repeated.records.map(entry => entry.epoch ?? '?').join(', ')})`
    : `${role} sessions (${repeated.records.map(entry => entry.requestId ?? entry.at).join(', ')})`;
  const hold = await recordObservedExhaustion(config, repeated.account, { at: last.at, resetsAt: last.resetsAt, role, profile: last.profile, work: work.key,
    reason: `${work.key}'s last ${repeated.records.length} ${launches} each ended on ${repeated.account}'s limit notice: ${last.reason}` }, now, report);
  return { account: repeated.account, hold };
}
