/**
 * GY-3757: per-item history reads share four slots, so many watchers of one item never take the
 * connections the loop's own reads need. A read that finds every slot busy waits up to `waitMs`;
 * then, when the same read answered before, it gets that answer and its age instead of waiting on.
 */
export const historyReadSlots = 4;
const waitMs = 5_000, remembered = 500;

let running = 0;
const waiting: (() => void)[] = [];
const last = new Map<string, { at: number; answer: unknown }>();

const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

/** Run `read` in a slot, or answer with the last answer for `key` and its age in ms after `waitMs` without one. */
export async function boundedHistoryRead<T>(key: string, read: () => Promise<T>): Promise<{ answer: T; ageMs: number | null }> {
  if (running < historyReadSlots) running++;
  else {
    let granted!: () => void;
    const slot = new Promise<void>(resolve => { granted = resolve; waiting.push(resolve); });
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([slot.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), waitMs); })]);
    clearTimeout(timer);
    const cached = last.get(key);
    if (!waited && cached) {
      // Give up the place in line; a slot granted meanwhile passes on.
      const index = waiting.indexOf(granted);
      if (index >= 0) waiting.splice(index, 1); else release();
      return { answer: cached.answer as T, ageMs: Date.now() - cached.at };
    }
    if (!waited) await slot;
  }
  try {
    const answer = await read();
    last.delete(key); last.set(key, { at: Date.now(), answer });
    if (last.size > remembered) last.delete(last.keys().next().value!);
    return { answer, ageMs: null };
  } finally { release(); }
}
