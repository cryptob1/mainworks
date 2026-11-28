import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannerPrompt } from '../src/daemon/planner.js';
import { flowNumbers } from '../src/flow-numbers.js';
import { flowItems } from '../src/server/flow.js';
import { workFixture } from './helpers/work-fixture.js';
import { bootstrapGate } from '../src/batch-gate.js';

test('integration:planner-prompt-separates-candidate-failures — recorded candidates and main results remain distinct', () => {
  const now = Date.parse('2026-11-28T05:00:00Z');
  const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const work = [workFixture({ key: 'GY-1' }), workFixture({ key: 'GY-2' })];
  const ledger = work.map((item, i) => ({ work_id: item.id, kind: 'merge.trial', seq: i + 1,
    created_at: at(4 - i), head: `candidate-${i + 1}`, base_tip: `base-${i + 1}`,
    trial: { failed: ['tests/candidate.test.ts', 'tests/main.test.ts'] } }));
  const flow = flowNumbers(flowItems(work, ledger), 6, now);
  const main = bootstrapGate('owner/repo', 'verified-tip');
  main.diagnosticsAt = at(2);
  main.diagnosticsRun = { at: at(2), outcome: 'passed', reason: null };
  main.sweeps = [{ at: at(1), tip: 'main-tip', items: ['GY-3'], failed: ['tests/main.test.ts'] }];
  const prompt = plannerPrompt({ brief: null, flow6h: flow, slowestTrialFiles: [], openTitles: [], now, main });
  assert.ok(prompt.includes('tests/candidate.test.ts 2, last failed 3h ago, candidate-only; newest GY-2 head candidate-2 base base-2; latest main pass at ' + at(2)), prompt);
  assert.ok(prompt.includes('tests/main.test.ts 2, last failed 3h ago, also failed on main; newest GY-2 head candidate-2 base base-2; latest main fail at ' + at(1)), prompt);
});
