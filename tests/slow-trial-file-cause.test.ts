import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credential, startPlane } from '../benchmarks/hard-math/isolation.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3910: tests/hard-math-repair.test.ts took 45-49 s in release checks because its in-process
// control plane reconciled every 50 ms, 40 times the served plane's 2 s (src/server/main.ts),
// competing with the run for the one CPU a trial lane has. This counts the timers the plane
// schedules; it measures no time. (The other cause, a remote shard held to one CPU, is pinned by
// e2e:two-host-trial's --cpus assertion.)
test('unit:slow-trial-file-cause — the hard-math in-process control plane schedules no tick faster than the served plane\'s 2 s', async () => {
  const scheduled: number[] = [], original = globalThis.setInterval;
  globalThis.setInterval = ((handler: (...args: any[]) => void, ms?: number, ...rest: any[]) => { scheduled.push(ms ?? 0); return original(handler, ms, ...rest); }) as typeof setInterval;
  let plane: Awaited<ReturnType<typeof startPlane>> | undefined;
  try {
    const directory = await temporaryDirectory('slow-trial-file-cause');
    plane = await startPlane(directory, directory, [credential('cause-admin', 'admin')], '0'.repeat(40));
  } finally { globalThis.setInterval = original; await plane?.stop(); }
  assert.ok(scheduled.length > 0, 'the plane schedules its reconciliation');
  assert.deepEqual(scheduled.filter(ms => ms < 2_000), [], `intervals scheduled: ${scheduled.join(', ')} ms`);
});
