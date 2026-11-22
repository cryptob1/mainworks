import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorRun, coordinatorTestBreadth, hostSuiteBreadth } from './helpers/run-tests.js';
import { heatGate } from './helpers/heat-hold.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3610: workers' own test runs were the largest CPU load on the coordinator and the cause of the
// heat that slowed every trial. On a machine that runs the master loop, a run that is not a trial
// shard starts at most four files at once and starts none while the CPU reads at the heat limit.

const plenty = async () => ({ totalBytes: 256 * 2 ** 30, availableBytes: 200 * 2 ** 30 });

test('unit:coordinator-test-runs-are-narrow-and-heat-aware — at most four files at once whatever the cores and memory, held while hot and resumed when cool, and a trial shard is unchanged', async () => {
  const slots = await temporaryDirectory('coordinator-breadth');
  const coordinator = { [slotsDirectoryVariable]: slots };
  assert.equal(coordinatorTestBreadth, 4);
  assert.equal(await hostSuiteBreadth(coordinator, plenty, process.pid, 24, ['tests/a.test.ts']), 4, 'a worker run on the coordinator starts four files with 24 cores and plenty of memory');
  assert.equal(await hostSuiteBreadth(coordinator, plenty, process.pid, 24, []), 4, 'a whole suite there too');
  assert.equal(await hostSuiteBreadth(coordinator, async () => null, process.pid, 24, []), 4, 'and when memory cannot be read');
  assert.equal(await hostSuiteBreadth({}, plenty, process.pid, 24, ['tests/a.test.ts']), 23, 'a machine that runs no master loop keeps its memory-afforded breadth');

  // A trial shard names its list (and its own --test-concurrency, which the runner keeps): neither narrowed nor held.
  assert.equal(coordinatorRun(coordinator, ['tests/a.test.ts']), true);
  assert.equal(coordinatorRun(coordinator, ['--files-from', 'tests-1.txt', '--durations', 'tests-1.jsonl', '--test-concurrency=6', '--file-timeout=300000']), false);
  assert.equal(coordinatorRun(coordinator, ['--shard', '1/4']), false);
  assert.equal(coordinatorRun({}, ['tests/a.test.ts']), false);
  assert.equal(await hostSuiteBreadth(coordinator, plenty, process.pid, 24, ['--files-from', 'tests-1.txt']), 23, 'a trial shard\'s breadth is unchanged');

  // The hold: the gate before each new file waits while the reading is at or over the limit (85C), and lets it start once it drops.
  const readings = [90, 85, 70], holds: number[] = [];
  let reads = 0;
  const gate = heatGate(async () => readings[Math.min(reads++, readings.length - 1)]!, { pollMs: 5, onHold: celsius => holds.push(celsius) });
  await gate();
  assert.equal(reads, 3, 'no file started until the reading dropped under the limit');
  assert.deepEqual(holds, [90], 'the hold is told once');
  await gate();
  assert.equal(reads, 4, 'a cool reading starts the next file at once');
  // No sensor: nothing waits on heat.
  await heatGate(async () => null)();
});
