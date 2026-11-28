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

test('unit:e2e-product-review-verdict-shown-pinned — the case unfolds the reviewer\'s notes before it reads the findings', () => {
  const steps = JSON.parse(readFileSync('e2e/cases/product-review-verdict-shown.json', 'utf8')).steps as { name?: string; action?: string; text?: string; body?: { findings?: string } }[];
  const recorded = steps.find(step => step.body?.findings)!.body!.findings!;
  const item = workFixture({
    id: 'w-1', key: 'GY-9', title: 'E2E case product-review-verdict-shown run r1', type: 'feature', stage: 'review', epoch: 1,
    criteria: [{ id: 'AC-1', text: 'reviewed', proofs: ['e2e:create-work-item'] }],
    productReview: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verdict: 'changes-requested', reviewer: 'product-reviewer', findings: recorded, screenshots: [], at: new Date().toISOString() },
  } as Parameters<typeof workFixture>[0]);
  const html = renderToStaticMarkup(createElement(ProductReviewPanel, { item, token: 't' }));
  const shownAt = steps.findIndex(step => step.name === 'the findings the reviewer gave are shown');
  const shown = steps[shownAt];
  assert.equal(shown.action, 'expectText');
  const at = html.indexOf(shown.text!);
  assert.ok(at >= 0, 'the panel renders the findings');
  const fold = html.lastIndexOf('<details', at);
  if (fold >= 0 && html.indexOf('</details>', fold) > at) {
    const summary = /<summary>([^<]+)<\/summary>/.exec(html.slice(fold))![1].replace(/&#x27;/g, "'");
    const unfold = steps.findIndex(step => step.action === 'click' && step.text === summary);
    assert.ok(unfold >= 0 && unfold < shownAt, `the case clicks "${summary}" before it expects the findings`);
  }
});
