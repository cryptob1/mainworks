import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { eventStageBackfill } from '../src/daemon/event-stage-backfill.js';

// GY-3771: backfill-stage-small-batches flaked on main for two timing-margin reasons:
// 1. eventStageBackfill targeted 2 s batches, leaving only 2.5x headroom under the test's 5 s statement timeout
//    (so a batch-gate CPU spike timed out a resized batch) and 1.5x under master status's 3 s slow-query mark.
// 2. The test's 1,000-row timeout probe ran at ~5.3 s vs 5.0 s (OPS = 64), and seeded on the 5 s timed pool.
test('unit:backfill-stage-small-batches-pinned — stage backfill targets <= 1 s batches for 5x timeout headroom and the test seeds outside the 5 s pool with > 2x probe margin', async () => {
  // Steady-state sizing on slow rows (10 ms/row): 50 rows take 500 ms -> next batch targets <= 1,000 ms (<= 100 rows).
  let clock = 0;
  const limits: number[] = [];
  const slow = eventStageBackfill(async limit => {
    limits.push(limit);
    clock += limit * 10;
    return { filled: limits.length < 3 ? limit : 0 };
  }, () => clock);
  await slow(() => {});
  await slow(() => {});
  assert.equal(limits[0], 50);
  assert.ok(limits[1] <= 100, `expected next batch <= 100 rows (<= 1 s at 10 ms/row), got ${limits[1]}`);

  // Fast rows (0.5 ms/row) still reach the 1,000-row cap on the second batch.
  clock = 0;
  const fastLimits: number[] = [];
  const fast = eventStageBackfill(async limit => {
    fastLimits.push(limit);
    clock += limit * 0.5;
    return { filled: fastLimits.length < 3 ? limit : 0 };
  }, () => clock);
  await fast(() => {});
  await fast(() => {});
  assert.equal(fastLimits[1], 1_000);

  // Fixture pins: OPS >= 128 (> 2x the 5 s timeout on 1,000 rows) and seeding completes before namedPool(..., TIMEOUT_MS).
  const source = await readFile(new URL('./backfill-stage-small-batches.test.ts', import.meta.url), 'utf8');
  const ops = Number(source.match(/\bOPS\s*=\s*(\d+)/)?.[1]);
  assert.ok(ops >= 128, `expected OPS >= 128 for > 2x 1,000-row timeout margin, got ${ops}`);
  const seedAt = source.indexOf('ANALYZE events');
  const poolAt = source.indexOf('namedPool(');
  assert.ok(seedAt > 0 && poolAt > seedAt, 'fixture seeding must finish before store.pool is replaced with the 5 s namedPool');
});
