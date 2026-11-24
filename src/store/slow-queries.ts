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
