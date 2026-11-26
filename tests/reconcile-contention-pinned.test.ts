import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3869: `unit:reconcile-tick-bounded-under-contention` in tests/reconcile-contention.test.ts
// previously lapsed 30 items, started `traffic()` (whose `resyncWork` loop triggers `engine.reconcile()`),
// slept 300 ms, and only then captured `earlier = new Set(engine.reconcileTicks)`. Whenever the
// resync-triggered tick finished reconciling those 30 lapsed items before the 300 ms warmup sleep
// resolved, `earlier` already included that tick, so the subsequent `engine.reconcile()` saw only
// the handful of items `traffic()` moved and failed `ticks.some(tick => tick.candidates >= 30)`.
// This seam injects that exact interleaving: it resolves the 300 ms warmup timer right after the
// in-flight `reconcileTick` finishes, reproducing the race on every run of the base tip.
const tsxUrl = import.meta.resolve('tsx/esm');
const engineUrl = pathToFileURL(resolve('src/engine.js')).href;
const warmupRaceSeam = `
await import(${JSON.stringify(tsxUrl)});
const { Engine } = await import(${JSON.stringify(engineUrl)});

let tickCompleted = 0;
let lastTick = null;
const tickWaiters = [];
const originalReconcileTick = Engine.prototype.reconcileTick;
Engine.prototype.reconcileTick = function (...args) {
  return originalReconcileTick.apply(this, args).finally(() => {
    tickCompleted++;
    lastTick = this.reconcileTicks.at(-1) ?? null;
    for (const check of tickWaiters.splice(0)) check();
  });
};

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (callback, delay, ...args) {
  if (delay === 300 && typeof callback === 'function') {
    const startCount = tickCompleted;
    const ready = () => tickCompleted > startCount && (tickCompleted >= startCount + 4 || (lastTick !== null && lastTick.candidates < 30));
    const wait = () => {
      if (ready()) { callback(...args); return; }
      tickWaiters.push(wait);
    };
    return originalSetTimeout(wait, 0);
  }
  return originalSetTimeout.call(this, callback, delay, ...args);
};
`;

test('unit:reconcile-contention-pinned — unit:reconcile-tick-bounded-under-contention passes deterministically when a traffic resync tick finishes before the warmup wait resolves', { timeout: 180_000 }, async () => {
  const preload = join(await temporaryDirectory('reconcile-contention-pinned'), 'preload.mjs');
  await writeFile(preload, warmupRaceSeam);
  const finished = await runTests({
    args: ['--test-name-pattern=reconcile-tick-bounded-under-contention', 'tests/reconcile-contention.test.ts'],
    stdio: 'pipe',
    environment: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() },
  });
  assert.equal(finished.code, 0, `tests/reconcile-contention.test.ts failed when a resync tick finished during warmup:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
});
