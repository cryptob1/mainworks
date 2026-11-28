import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductReviewPanel } from '../web/pages/work-details.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-4096: GY-3962 folded the reviewer's findings into a closed "Reviewer's notes" fold (findings can name
// proof ids, which stay out of the primary view), and the case went on waiting 30 s for text a person
// could not see. The case now unfolds the notes before it reads the findings.

// Attempt 3: the step "the verdict binds the exact head it judged" found no head either, since the panel
// dropped it; the head now sits in the same fold, so every text the case expects is checked here.

test('unit:e2e-product-review-verdict-shown-pinned — every text the case expects is on the panel, its fold opened first', () => {
  const steps = JSON.parse(readFileSync('e2e/cases/product-review-verdict-shown.json', 'utf8')).steps as { kind: string; action?: string; text?: string; body?: { findings?: string; screenshots?: { name: string }[] } }[];
  const recorded = steps.find(step => step.body?.findings)!.body!;
  const item = workFixture({
    id: 'w-1', key: 'GY-9', title: 'E2E case product-review-verdict-shown run r1', type: 'feature', stage: 'review', epoch: 1,
    criteria: [{ id: 'AC-1', text: 'reviewed', proofs: ['e2e:create-work-item'] }],
    productReview: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verdict: 'changes-requested', reviewer: 'product-reviewer', findings: recorded.findings!, screenshots: recorded.screenshots!.map(shot => shot.name), at: new Date().toISOString() },
  } as Parameters<typeof workFixture>[0]);
  const html = renderToStaticMarkup(createElement(ProductReviewPanel, { item, token: 't' })).replace(/&#x27;/g, "'");
  const panelFrom = steps.findIndex(step => step.action === 'expectText' && step.text === 'Product review');
  const expected = steps.map((step, index) => ({ step, index })).filter(({ step, index }) => index >= panelFrom && step.action === 'expectText');
  assert.equal(expected.length, 5, 'heading, verdict, findings, screenshot and head');
  for (const { step, index } of expected) {
    const at = html.indexOf(step.text!);
    assert.ok(at >= 0, `the panel renders "${step.text}"`);
    const fold = html.lastIndexOf('<details', at);
    if (fold < 0 || html.indexOf('</details>', fold) < at) continue;
    const summary = /<summary>([^<]+)<\/summary>/.exec(html.slice(fold))![1];
    const unfold = steps.findIndex(other => other.action === 'click' && other.text === summary);
    assert.ok(unfold >= 0 && unfold < index, `the case clicks "${summary}" before it expects "${step.text}"`);
  }
});
