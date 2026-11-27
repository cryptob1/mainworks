// GY-3961: a supervised Builder session that writes no log output for 30 minutes ends its attempt —
// the supervisor stops it and releases the lease naming the idle time — while a session that keeps
// writing is never stopped for idleness. Time runs on an injected clock; output is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { supervise } from '../src/session-watch.js';

const minute = 60_000;
const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };

/** Supervises SCRIPT on a fake clock, one renewal tick a minute; WAIT_OUTPUT holds each tick until the log grew. */
async function run(script: string, waitForOutput: boolean, ticks: number) {
  const log = join(await temporaryDirectory('idle-session-'), 'run.jsonl');
  let current = 0, nextId = 0, renewals = 0;
  const tasks = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const add = (fn: () => void, ms = 0, every: number | null = null) => { const id = ++nextId; tasks.set(id, { at: current + Math.max(0, ms), every, fn }); return id; };
  const remove = (id: unknown) => { tasks.delete(id as number); };
  const clock = { now: () => current, setTimeout: (fn: () => void, ms?: number) => add(fn, ms), clearTimeout: remove, setInterval: (fn: () => void, ms?: number) => add(fn, ms, Math.max(1, ms ?? 0)), clearInterval: remove };
  const causes: string[] = [];
  const renew = async () => {
    // After TICKS renewals the plane refuses, which ends a session that was never stopped for idleness.
    if (++renewals > ticks) throw Object.assign(new Error('refused'), { status: 409 });
    return { updatedAt: new Date(0).toISOString(), lease: { epoch: 1, expiresAt: new Date(120 * minute).toISOString() } };
  };
  let done = false;
  const supervising = supervise(process.execPath, ['-e', script], 1, renew, { intervalMs: minute, graceMs: 50, clock, log, worktree: dirname(log), session: { surrender: async cause => { causes.push(cause); } } });
  void supervising.finally(() => { done = true; });
  // The stand-in prints its first line before any time passes.
  while (size(log) === 0) await delay(5);
  let seen = size(log);
  while (!done) {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    if (done) break;
    let soonest: [number, { at: number; every: number | null; fn: () => void }] | undefined;
    for (const entry of tasks) if (!soonest || entry[1].at < soonest[1].at) soonest = entry;
    if (!soonest) { await delay(1); continue; }
    const [id, task] = soonest;
    if (waitForOutput && task.every === minute) { while (size(log) === seen) await delay(5); seen = size(log); }
    current = task.at;
    if (task.every !== null) task.at = current + task.every; else tasks.delete(id);
    task.fn();
    await delay(1);
  }
  return { code: await supervising, causes, minutes: current / minute, log: readFileSync(log, 'utf8') };
}

test('integration:idle-builder-session-ends — a session that prints once and then sleeps is stopped after 30 silent minutes and its lease released naming the idle time', { timeout: 60_000 }, async () => {
  const result = await run("console.log('started'); setInterval(() => {}, 1000)", false, 120);
  assert.equal(result.code, 1);
  assert.deepEqual(result.causes, ['the session wrote no output, used no CPU and changed no file for 30 minutes']);
  assert.ok(result.minutes >= 30 && result.minutes < 33, `stopped at minute ${result.minutes}`);
  assert.match(result.log, /started/);
});

test('integration:idle-builder-session-ends — a session that keeps writing output is never stopped for idleness', { timeout: 60_000 }, async () => {
  const result = await run("setInterval(() => console.log('working'), 20)", true, 45);
  assert.equal(result.code, 1);
  assert.deepEqual(result.causes, [], 'only the refused renewal ended it');
  assert.ok(result.minutes >= 45, `ran ${result.minutes} minutes`);
});
