/**
 * GY-3757: the slowest database statement of the last ten minutes, when it ran past three seconds,
 * named by its SQL, for master status. Every statement the named pools run is timed (statements.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const slowMs = 3_000, windowMs = 10 * 60_000;
/** GY-3762: who asked: the route and principal, and the CLI command when the client names it. */
export interface SlowQuery { name: string; ms: number; at: number; caller?: string }
export const queryCaller = new AsyncLocalStorage<string>();
let slow: SlowQuery[] = [];

/** A statement's name: its SQL on one line, cut to 120 characters. */
export const queryName = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 120);

export function recordQuery(text: string, ms: number, now = Date.now()) {
  if (ms <= slowMs) return;
  slow = slow.filter(query => now - query.at <= windowMs);
  const caller = queryCaller.getStore();
  slow.push({ name: queryName(text), ms, at: now, ...(caller ? { caller } : {}) });
}

/** The slowest of the window, or of the statements whose name starts with `prefix`. */
export function slowestQuery(now = Date.now(), prefix = ''): SlowQuery | null {
  slow = slow.filter(query => now - query.at <= windowMs);
  return slow.filter(query => query.name.startsWith(prefix)).reduce<SlowQuery | null>((max, query) => !max || query.ms > max.ms ? query : max, null);
}

/** GY-3799: the longest coordination-lock hold of the last ten minutes, when it held the lock 1 s or more, named by its route or step. */
const holdMs = 1_000;
export interface LockHold { name: string; ms: number; at: number }
let holds: LockHold[] = [];
export function recordLockHold(name: string, ms: number, now = Date.now()) {
  if (ms < holdMs) return;
  holds = holds.filter(hold => now - hold.at <= windowMs);
  holds.push({ name, ms, at: now });
}
export function longestLockHold(now = Date.now()): LockHold | null {
  holds = holds.filter(hold => now - hold.at <= windowMs);
  return holds.reduce<LockHold | null>((max, hold) => !max || hold.ms > max.ms ? hold : max, null);
}
/** Who took the lock: the request's caller, else the first frame of the stack outside the store. */
export function lockHolderName(stack: Error, caller = queryCaller.getStore()) {
  if (caller) return caller;
  const frame = (stack.stack ?? '').split('\n').slice(1).map(line => line.trim().replace(/^at (async )?/, ''))
    .find(line => /\/src\//.test(line) && !/\/src\/store\//.test(line));
  return frame ? frame.replace(/\(?(file:\/\/)?\S*\/(src\/[^:)]+):(\d+):\d+\)?/, '$2:$3').trim() : 'a background step';
}
