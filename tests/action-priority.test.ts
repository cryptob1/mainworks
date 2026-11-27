import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { openActions } from '../src/model/actions.js';
import { reconcileActions } from '../src/model-boundary/actions.js';
import { actionJudgment } from '../src/model/action-kinds.js';
import { humanNeeded } from '../src/model/concerns.js';
import { nextAction } from '../src/model-boundary/next-action.js';
import { workFixture } from './helpers/work-fixture.js';
// Time-bomb allowance (GY-1694): 2026-09-21 `at` is the fixed now handed to nextAction.

/**
 * GY-104: an item stops only for a judgement it actually needs. The test here is named for the
 * proof it produces: unit:human-needed-actions-visible.
 */

// ---- AC-4: an action no executor may run is owed by somebody, and counted apart -----------------

const at = '2026-09-21T12:00:00.000Z';
const probe = (overrides: Partial<Work> = {}): Work => workFixture({
  title: 'Owed', criteria: [{ id: 'AC-1', text: 'Specified work', proofs: ['e2e:fixture'] }], stage: 'merge', epoch: 1,
  gates: [], agentRequests: [], sessions: [], createdAt: at, updatedAt: at, stageEnteredAt: at, ...overrides,
});

test('unit:human-needed-actions-visible — an item whose only action is escalate is recorded as needing a person and counted apart from the rows executors are taking', () => {
  const now = new Date(Date.parse(at) + 30_000);
  // The one refusal no executor step answers: branch protection nobody has verified.
  const refusal = 'Required Mainworks check and merge-queue branch protection have not been verified';
  const owedItem = probe({ gates: [{ name: 'merge', passed: false, reasons: [refusal] }] } as Partial<Work>);
  const computed = nextAction(owedItem, [owedItem], new Date(at))!;
  assert.equal(computed.kind, 'attention');
  assert.equal(actionJudgment.attention, 'in-step');
  assert.deepEqual(computed.needsHuman, { decision: `resolving ${owedItem.key}'s refusal`, resolve: `mainworks diagnose ${owedItem.key} — ${refusal}` });
  assert.deepEqual(humanNeeded(computed), computed.needsHuman, 'what the action records is what the rule says');

  // Beside it, a row an executor is simply yet to take.
  const queuedItem = probe({ key: 'GY-2', id: 'id-GY-2', gates: [{ name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }] } as Partial<Work>);
  assert.equal(nextAction(queuedItem, [queuedItem], new Date(at))!.kind, 'dispatch');
  const work = [owedItem, queuedItem];
  for (const item of work) {
    item.nextAction = nextAction(item, work, new Date(at));
    reconcileActions(item, work, new Date(at), { next: item.nextAction });
  }

  // Both rows are unclaimed.
  assert.deepEqual(openActions(work, now).map(entry => entry.row.kind).sort(), ['attention', 'dispatch']);
});
