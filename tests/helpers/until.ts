import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>;

/** GY-3943: polls `condition` every `pollMs` until it answers a truthy value, and returns it; fails naming `what` after `timeoutMs`. */
export async function until<T>(condition: () => T | Promise<T>, what: string, timeoutMs = 10_000, pollMs = 20): Promise<Truthy<T>> {
  for (const deadline = Date.now() + timeoutMs; ;) {
    const value = await condition();
    if (value) return value as Truthy<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await sleep(pollMs);
  }
}
