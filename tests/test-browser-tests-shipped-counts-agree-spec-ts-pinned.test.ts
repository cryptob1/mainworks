import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3578: browser-tests/shipped-counts-agree.spec.ts was removed with the Work page card it read (GY-3600).

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
