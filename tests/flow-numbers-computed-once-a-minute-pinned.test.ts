import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { trialFileTimeoutMs } from './helpers/run-tests.js';

// GY-3793: flow-numbers-computed-once-a-minute seeded its 7-day window only 1 minute inside the
// boundary and ran ANALYZE without VACUUM on 2,000,000 newly inserted rows. Under merge-trial load,
// rows could age out of the 7-day window before the test checked them and the first reads dirtied
// pages setting hint bits.
test('unit:flow-numbers-computed-once-a-minute-pinned — window seed stays safely inside the 7-day boundary beyond the trial timeout and vacuums events before timing reads', async () => {
  const source = await readFile(new URL('./flow-numbers-computed-once-a-minute.test.ts', import.meta.url), 'utf8');
  const match = source.match(/row\(WINDOW,\s*`now\(\)\s*-\s*interval '7 days'\s*\+\s*interval '(\d+) minutes?'`/);
  assert.ok(match, 'window seed defines a minute offset inside the 7-day boundary');
  const marginMs = Number(match[1]) * 60_000;
  assert.ok(marginMs > trialFileTimeoutMs, `window seed margin (${match[1]}m) must exceed trialFileTimeoutMs (${trialFileTimeoutMs}ms)`);
  assert.match(source, /VACUUM ANALYZE events/, 'fixture runs VACUUM ANALYZE events after seeding two million rows');
});
