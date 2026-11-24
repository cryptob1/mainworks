import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// GY-3795: flow-attempts-fast's e2e test asserts the server ran no flow query over 3 s. The integration test's own
// cold attempts read ran on the server's timed pool, and the 2M-row events table was neither vacuumed nor warmed on
// the plain fixture client before the e2e read, so under load a cold flow query entered that report and failed the e2e test.
test('unit:flow-attempts-fast-pinned — flow-attempts-fast runs its own flow reads and warmup on the plain fixture client, never the server\'s timed pool', async () => {
  const source = await readFile(new URL('./flow-attempts-fast.test.ts', import.meta.url), 'utf8');
  const runners = [...source.matchAll(/([\w.]+)\.query\(flow(?:Ledger|Attempts)Sql/g)].map(match => match[1]);
  assert.ok(runners.length > 0, 'the test reads the flow queries');
  assert.deepEqual([...new Set(runners)], ['fixture']);
  assert.doesNotMatch(source, /store\.pool\.(connect|query)\(/);
  assert.match(source, /VACUUM ANALYZE events/);
  assert.match(source, /fixture\.query\(flowLedgerSql/);
});
