import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runWorkerPull, workerPullIntervalMs } from '../src/dispatch/worker-pull.js';

// GY-3789: tests/action-queue.test.ts measured wall-clock Date.now() - readyAt against
// `measuredP90 <= 4 * pollMs` (400 ms) while running real Postgres polls and setTimeout(100),
// which flaked under parallel trial load when a single poll + timer wakeup exceeded 400 ms.
test('unit:action-queue-pinned — runWorkerPull accepts an injected wait and action-queue measures ready-to-claim deterministically', async () => {
  let clock = 0;
  let calls = 0;
  const waits: number[] = [];
  const result = await runWorkerPull(async () => ({
    assigned: ++calls === 2 ? ({ id: 'work-1', key: 'GY-1' } as any) : null,
    offered: calls === 2 ? 1 : 0,
  }), {
    intervalMs: 25,
    maxPolls: 5,
    now: () => clock,
    wait: async ms => {
      waits.push(ms);
      clock += ms;
    },
  });
  assert.deepEqual(waits, [25], 'runWorkerPull must delegate interval sleeps to the injected wait');
  assert.equal(result.polls, 2);
  assert.equal(result.waitedMs, 25);

  // At the shipped interval (30 s), injected wait + clock completes immediately with exact timing.
  let shippedClock = 0;
  let shippedCalls = 0;
  const shipped = await runWorkerPull(async () => ({
    assigned: ++shippedCalls === 2 ? ({ id: 'work-2', key: 'GY-2' } as any) : null,
    offered: shippedCalls === 2 ? 1 : 0,
  }), {
    intervalMs: workerPullIntervalMs,
    maxPolls: 5,
    now: () => shippedClock,
    wait: async ms => { shippedClock += ms; },
  });
  assert.equal(shipped.polls, 2);
  assert.equal(shipped.waitedMs, workerPullIntervalMs);

  const source = await readFile(new URL('./action-queue.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /measuredP90\s*<=\s*4\s*\*\s*pollMs/, 'action-queue.test.ts must not assert a wall-clock 4 * pollMs threshold');
  assert.match(source, /wait:\s*async/, 'action-queue.test.ts must drive runWorkerPull with an injected wait');
});
