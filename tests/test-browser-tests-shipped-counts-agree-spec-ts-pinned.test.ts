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

// GY-3578 rework: the merge trial then failed browser-tests/master-stall-alarm.spec.ts with "Cannot read properties of
// undefined (reading 'some')": since GY-3503 the stall alarm reads each open item's dependencies, which every Work
// carries, and the spec's hand-built item had none. The alarm the spec computes for its fixture must not throw.
test('unit:test-browser-tests-shipped-counts-agree-spec-ts-pinned — the stall-alarm spec fixture is a whole Work the alarm can read', async () => {
  const { stallAlarm } = await import('../src/daemon/stall-alarm');
  const { emptyDaemonState } = await import('../src/daemon/state');
  const spec = readFileSync(join(process.cwd(), 'browser-tests/master-stall-alarm.spec.ts'), 'utf8');
  const literal = spec.match(/const item = (\{[^\n]*\}) as unknown as Work;/)?.[1];
  assert.ok(literal, 'the spec names its fixture item');
  const start = Date.parse('2026-11-16T08:00:00Z');
  const item = new Function('start', `return ${literal};`)(start);
  const running = { ...item, stage: 'build', sessions: [{ kind: 'implementation', state: 'running', startedAt: new Date(start + 12 * 60_000).toISOString() }] };
  const state = emptyDaemonState({ url: 'http://127.0.0.1:9', repository: 'fixture/shop' } as never);
  assert.equal(stallAlarm({ now: start + 12 * 60_000, open: [running], ready: [], freeSlots: 0, state, registry: null, serving: null }), null);
});
