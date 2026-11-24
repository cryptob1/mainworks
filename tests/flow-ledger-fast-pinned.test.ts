import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// GY-3767: flow-ledger-fast's e2e test asserts the server ran no flow query over 3 s. The integration test's own
// cold ledger read ran on the server's timed pool, so under load it entered that report and failed the e2e test.
test('unit:flow-ledger-fast-pinned — flow-ledger-fast runs its own flow reads on the plain fixture client, never the server\'s timed pool', async () => {
  const source = await readFile(new URL('./flow-ledger-fast.test.ts', import.meta.url), 'utf8');
  const runners = [...source.matchAll(/([\w.]+)\.query\(flow(?:Ledger|Attempts)Sql/g)].map(match => match[1]);
  assert.ok(runners.length > 0, 'the test reads the flow ledger');
  assert.deepEqual([...new Set(runners)], ['fixture']);
  assert.doesNotMatch(source, /store\.pool\.(connect|query)\(/);
});
