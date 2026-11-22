import type { Work } from '../src/model';
import type { HumanRequestRow } from '../src/model/human-request';
import { isClosed } from '../src/model';

/**
 * The Lead's conversation (GY-3602): one time-ordered feed of the messages people typed into the
 * Lead's pane and the cards its own records reply with. Every card comes from a record the
 * control plane already holds — an open human-only request (approval), an audited decision on the
 * ledger (decision), an open deployment incident (incident) and a filed item (task) — so the feed
 * renders what is, never a summary a model wrote. Newest is last, as a chat reads.
 */

/** One line a person typed into the Lead's pane, as `GET /api/typed-input` serves it. */
export interface TypedLine { who: string; at: string; text: string }
/** One ledger row the decisions and filings are read from (`GET /api/events`, `payload=details`). */
export interface LedgerRow { seq: string; work_id: string | null; actor: string; kind: string; created_at: string; details?: Record<string, unknown> | null }
/** One agent-registry change row (`GET /api/agent-registry/history`). */
export interface RegistryRow { seq: string; at: string; actor: string; kind: string; change?: { role?: { name?: string; concurrency?: number }; roles?: { name?: string; concurrency?: number }[]; reason?: string } | null }
/** An open deployment incident as the production watch reports it (src/production-watch.ts). */
export interface FeedIncident { id: string; workId: string; key: string; status: 'failed' | 'missing'; reason: string; since: string }

export interface FeedMessage { kind: 'message'; at: number; who: string; text: string }
export interface FeedApproval { kind: 'approval'; at: number; row: HumanRequestRow }
/** What a decision's Undo runs: a work command the signed-in person may post, or a registry write. */
export type Undo =
  | { target: 'work'; workId: string; command: string; data: Record<string, unknown> }
  | { target: 'registry'; body: Record<string, unknown> };
export interface FeedDecision { kind: 'decision'; at: number; what: string; why: string | null; undo: Undo | null }
export interface FeedIncidentCard { kind: 'incident'; at: number; incident: FeedIncident }
export interface FeedTask { kind: 'task'; at: number; item: { id: string; key: string; title: string } }
export type LeadEntry = FeedMessage | FeedApproval | FeedDecision | FeedIncidentCard | FeedTask;

/** How many entries the conversation keeps: the newest this many, whatever kinds they are. */
export const leadFeedLimit = 80;

const iso = (value: string) => { const at = Date.parse(value); return Number.isFinite(at) ? at : null; };
const text = (value: unknown) => typeof value === 'string' ? value : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The ledger kinds that read as the Lead's decisions; every other row is not a reply. */
export const decisionKinds = ['priority', 'hold', 'rework', 'unblock', 'requirements', 'message'] as const;
/** Every ledger kind the conversation reads: the decisions above, and the filings. */
export const ledgerKinds = [...decisionKinds, 'create'] as const;

/**
 * One ledger row as the Lead's decision, or null when it is none. The owner's own steering from the
 * Work page (a priority change recorded "from the dashboard") is their message to act, not the
 * Lead's reply, so it is left out.
 */
export function decisionFrom(row: LedgerRow, work: readonly Work[]): FeedDecision | null {
  const at = iso(row.created_at), details = row.details ?? {};
  const item = row.work_id ? work.find(entry => entry.id === row.work_id) : undefined;
  const key = item?.key ?? row.work_id?.slice(0, 8) ?? 'an item';
  const why = text(details.reason);
  const undoWork = (command: string, data: Record<string, unknown>): Undo | null => row.work_id && item ? { target: 'work', workId: row.work_id, command, data } : null;
  if (row.kind === 'priority') {
    const priority = number(details.priority) ?? number(details.newPriority), previous = number(details.oldPriority);
    if (why?.endsWith('from the dashboard') || at === null || priority === null || previous === null) return null;
    return { kind: 'decision', at, what: `Priority for ${key} moved to P${priority}`, why, undo: undoWork('priority', { priority: previous, reason: `Owner undid the priority change for ${key} from the Lead page` }) };
  }
  if (row.kind === 'hold' && at !== null)
    return { kind: 'decision', at, what: `${key} held out of dispatch`, why, undo: undoWork('ready', { expectedRevision: item?.revision, reason: `Owner undid the hold on ${key} from the Lead page` }) };
  if (row.kind === 'rework' && at !== null) return { kind: 'decision', at, what: `${key} sent back for changes`, why, undo: null };
  if (row.kind === 'unblock' && at !== null) return { kind: 'decision', at, what: `${key} unblocked`, why, undo: null };
  if (row.kind === 'requirements' && at !== null) return { kind: 'decision', at, what: `Requirements for ${key} changed`, why, undo: null };
  if (row.kind === 'message' && at !== null) return { kind: 'decision', at, what: `Messaged ${key}'s builder`, why: text(details.text), undo: null };
  return null;
}

/** The concurrency a role last had before a row set it, or null when the history names none. */
function previousConcurrency(rows: readonly RegistryRow[], name: string, before: string): number | null {
  for (const row of rows) { // rows arrive newest first: the first older mention is the previous value
    if (row.at >= before) continue;
    const direct = number(row.change?.role?.name === name ? row.change?.role?.concurrency : undefined);
    if (direct !== null) return direct;
    const applied = row.change?.roles?.find(entry => entry.name === name);
    if (applied && number(applied.concurrency) !== null) return number(applied.concurrency)!;
  }
  return null;
}

/** Every registry pause in the history read: a role set to concurrency 0, newest first in, oldest first out. */
export function pausesFrom(rows: readonly RegistryRow[], limit = leadFeedLimit): FeedDecision[] {
  const entries: FeedDecision[] = [];
  for (const row of rows) {
    const role = row.change?.role;
    const at = iso(row.at);
    if (row.kind !== 'role.set' || !role?.name || number(role.concurrency) !== 0 || at === null) continue;
    const previous = previousConcurrency(rows, role.name, row.at);
    entries.push({ kind: 'decision', at, what: `The ${role.name} role paused`, why: text(row.change?.reason),
      undo: previous === null ? null : { target: 'registry', body: { role: { name: role.name, concurrency: previous }, reason: `Owner unpaused the ${role.name} role from the Lead page` } } });
  }
  return entries.sort((a, b) => a.at - b.at).slice(-limit);
}

/** One ledger row as a filed-task card, or null: the newest filing of an item the board still lists. */
export function taskFrom(row: LedgerRow, work: readonly Work[]): FeedTask | null {
  const at = iso(row.created_at);
  if (row.kind !== 'create' || at === null || !row.work_id) return null;
  const item = work.find(entry => entry.id === row.work_id);
  if (!item) return null;
  return { kind: 'task', at, item: { id: item.id, key: item.key, title: item.title } };
}

/**
 * The whole conversation, oldest first. Messages, cards and filings keep their own instants; equal
 * instants keep the order they were given (messages first, then ledger rows by sequence).
 */
export function leadFeed(input: { typed: readonly TypedLine[]; requests: readonly HumanRequestRow[]; ledger: readonly LedgerRow[]; registry?: readonly RegistryRow[]; incidents?: readonly FeedIncident[]; work: readonly Work[] }): LeadEntry[] {
  const entries: LeadEntry[] = [];
  for (const line of input.typed) { const at = iso(line.at); if (at !== null && line.text.trim()) entries.push({ kind: 'message', at, who: line.who, text: line.text }); }
  for (const row of input.ledger) {
    const decision = decisionFrom(row, input.work);
    if (decision) { entries.push(decision); continue; }
    const task = taskFrom(row, input.work);
    if (task) entries.push(task);
  }
  for (const pause of pausesFrom(input.registry ?? [])) entries.push(pause);
  for (const request of input.requests) { const at = iso(request.request.at); if (at !== null) entries.push({ kind: 'approval', at, row: request }); }
  for (const incident of input.incidents ?? []) { const at = iso(incident.since); if (at !== null) entries.push({ kind: 'incident', at, incident }); }
  return entries.sort((a, b) => a.at - b.at).slice(-leadFeedLimit);
}

/** The side rail's goal order: the open items by priority, oldest first on ties, titles only. */
export function goalOrder(work: readonly Work[], count = 3) {
  return work.filter(item => item.stage !== 'done' && !isClosed(item))
    .sort((a, b) => a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, count).map(item => ({ id: item.id, key: item.key, title: item.title }));
}

/** Who can steer the Lead: the operator ("You" when this session is the operator's) and every maintainer. */
export function steerers(teammates: readonly { login: string; role: string }[], operator: boolean): string[] {
  const named = teammates.filter(teammate => teammate.role === 'maintainer').map(teammate => teammate.login.split('@')[0]);
  return [...(operator ? ['You'] : ['The operator']), ...named];
}
