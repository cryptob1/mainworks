// GY-4017: a supervised session is ended as idle only when its run log, its processes' CPU and its
// worktree were all quiet for 30 minutes. A stand-in that prints nothing but burns CPU and writes
// worktree files keeps its attempt; one that prints once and sleeps is ended. Time runs on an
// injected clock; the processes, their CPU and their files are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { supervise } from '../src/session-watch.js';

const minute = 60_000;
const modified = (worktree: string) => { try { return statSync(join(worktree, 'work.txt')).mtimeMs; } catch { return 0; } };

/** Supervises SCRIPT (given its worktree as argv[1]) on a fake clock, one tick a minute, each tick held until READY says the stand-in did its part. */
async function run(script: string, ticks: number, ready: (worktree: string, log: string) => boolean) {
  const worktree = await temporaryDirectory('quiet-busy-'), log = join(await temporaryDirectory('quiet-busy-log-'), 'run.jsonl');
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
  const supervising = supervise(process.execPath, ['-e', script, worktree], 1, renew, { intervalMs: minute, graceMs: 50, clock, log, worktree, session: { surrender: async cause => { causes.push(cause); } } });
  void supervising.finally(() => { done = true; });
  while (!done) {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    if (done) break;
    let soonest: [number, { at: number; every: number | null; fn: () => void }] | undefined;
    for (const entry of tasks) if (!soonest || entry[1].at < soonest[1].at) soonest = entry;
    if (!soonest) { await delay(1); continue; }
    const [id, task] = soonest;
    if (task.every === minute) while (!done && !ready(worktree, log)) await delay(5);
    current = task.at;
    if (task.every !== null) task.at = current + task.every; else tasks.delete(id);
    task.fn();
    await delay(1);
  }
  return { code: await supervising, causes, minutes: current / minute };
}

// Prints nothing; every 20 ms it spins the CPU and rewrites a worktree file.
const busy = "const { writeFileSync } = require('node:fs'); let n = 0; setInterval(() => { const end = Date.now() + 10; while (Date.now() < end); writeFileSync(require('node:path').join(process.argv[1], 'work.txt'), String(n++)); }, 20)";

test('integration:quiet-busy-session-not-idle — a session that prints nothing but uses CPU and changes worktree files is never ended as idle', { timeout: 60_000 }, async () => {
  let seen = 0;
  const result = await run(busy, 45, worktree => { const newest = modified(worktree); if (newest === seen) return false; seen = newest; return true; });
  assert.equal(result.code, 1);
  assert.deepEqual(result.causes, [], 'only the refused renewal ended it');
  assert.ok(result.minutes >= 45, `ran ${result.minutes} minutes`);
});

test('integration:quiet-busy-session-not-idle — a session that prints once and then sleeps is ended after 30 quiet minutes', { timeout: 60_000 }, async () => {
  const result = await run("console.log('started'); setTimeout(() => {}, 1e9)", 120, (_, log) => { try { return statSync(log).size > 0; } catch { return false; } });
  assert.equal(result.code, 1);
  assert.deepEqual(result.causes, ['the session wrote no output, used no CPU and changed no file for 30 minutes']);
  assert.ok(result.minutes >= 30 && result.minutes < 33, `ended at minute ${result.minutes}`);
});
