import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductReviewPanel } from '../web/pages/work-details.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-4096: GY-3962 folded the reviewer's findings into a closed "Reviewer's notes" fold, so the case's
// "the findings the reviewer gave are shown" step waited 30 s for text a person could not see. The
// findings are what a change request says; the panel shows them open.

test('unit:e2e-product-review-verdict-shown-pinned — the findings show open on the Product review panel, not inside a closed fold', () => {
  const steps = JSON.parse(readFileSync('e2e/cases/product-review-verdict-shown.json', 'utf8')).steps as { name?: string; action?: string; text?: string; body?: { findings?: string } }[];
  const recorded = steps.find(step => step.body?.findings)!.body!.findings!;
  const shown = steps.find(step => step.name === 'the findings the reviewer gave are shown')!;
  assert.equal(shown.action, 'expectText');
  const item = workFixture({
    id: 'w-1', key: 'GY-9', title: 'E2E case product-review-verdict-shown run r1', type: 'feature', stage: 'review', epoch: 1,
    criteria: [{ id: 'AC-1', text: 'reviewed', proofs: ['e2e:create-work-item'] }],
    productReview: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verdict: 'changes-requested', reviewer: 'product-reviewer', findings: recorded, screenshots: [], at: new Date().toISOString() },
  } as Parameters<typeof workFixture>[0]);
  const html = renderToStaticMarkup(createElement(ProductReviewPanel, { item, token: 't' }));
  const at = html.indexOf(shown.text!);
  assert.ok(at >= 0, 'the panel renders the findings');
  const before = html.slice(0, at);
  assert.equal((before.match(/<details/g) ?? []).length, (before.match(/<\/details>/g) ?? []).length, 'the findings are not inside a closed fold');
});
