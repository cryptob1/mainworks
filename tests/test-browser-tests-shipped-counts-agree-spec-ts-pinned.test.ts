import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3578: browser-tests/shipped-counts-agree.spec.ts failed on the batch gate and passed its re-run. Reproduced
// under load (200 runs on 64 workers): a run waited 5 s for the Work heading after sign-in. The render is CPU-bound
// and a loaded trial host runs past the 5 s default, so every wait in the spec allows the suite's settled 15 s.
test('unit:test-browser-tests-shipped-counts-agree-spec-ts-pinned — every wait in shipped-counts-agree allows the settled time', () => {
  const spec = readFileSync(join(process.cwd(), 'browser-tests/shipped-counts-agree.spec.ts'), 'utf8');
  assert.match(spec, /const settled = \{ timeout: 15_000 \};/, 'the spec names the settled wait');
  const waits = spec.split('\n').filter(line => line.includes('await expect('));
  assert.equal(waits.length, 7, `the spec's waits are found: ${waits.length}`);
  for (const wait of waits) assert.match(wait, /settled\);$/, `the wait allows the settled time: ${wait.trim()}`);
});
