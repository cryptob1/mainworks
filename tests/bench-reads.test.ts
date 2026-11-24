import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseUrl } from './helpers/postgres.js';
import { benchCommands } from '../src/cli/bench.js';
import { benchReadEvents, benchReads } from '../src/bench-reads.js';

// GY-3792: the large-table timings run once from `bench reads`, never in trials or the release check.
test('unit:bench-has-large-table-read-run — bench reads seeds two million events by default and reports the four reads\' times', async () => {
  assert.equal(benchReadEvents, 2_000_000);
  assert.match(benchCommands[0].help.join('\n'), /bench reads \[--events N\][^\n]*2,000,000 events/);
  const result = await benchReads(await databaseUrl('bench-reads'), 2000);
  assert.equal(result.events, 2000);
  assert.deepEqual(Object.keys(result.reads).sort(), ['eventHistoryPage', 'flowComputation', 'flowLedger', 'itemStatus']);
  for (const ms of Object.values(result.reads)) assert.ok(Number.isInteger(ms) && ms >= 0);
});
