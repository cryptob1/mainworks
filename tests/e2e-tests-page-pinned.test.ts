import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TestsView } from '../web/pages/tests.js';

// GY-3378: the tests-page E2E case expected header text the Tests page no longer renders, and looked
// for the folded linked items in the matrix view that does not show them. Every text the case expects
// must render in the view its clicks lead to. GY-3972: the trial serves a scratch repository whose main has
// no tests-page file, and the case has no run yet, so its row sits in the folded cases of items not built
// yet; the case opens that fold, and only then does the text inside it count as shown.

const noop = () => {};
const at = '2026-11-01T00:00:00.000Z';
const entry = { id: 'tests-page', title: 'The Tests page lists the test cases and their history', purpose: null, testPath: 'e2e/cases/tests-page.json', environment: null,
  revision: 1, changed: { at, by: 'operator' }, latest: null, staleRevision: false, runs: 0, failures: 0, lastFailure: null, flaky: false, flakyReason: null, passRate: null, history: [],
  onMain: false, links: Array.from({ length: 5 }, (_, i) => ({ id: `w${i + 1}`, key: `GY-${i + 1}`, title: `Item ${i + 1}`, stage: 'backlog', criteria: [{ id: 'AC-1', text: 'The Tests page folds a case\'s many linked items' }] })) };
const text = (view: 'matrix' | 'cases', open = false) => renderToStaticMarkup(createElement(TestsView, { data: { window: 20, cases: [entry as any] }, view, error: '', loading: false, filter: 'all', setFilter: noop, retry: noop, api: async () => ({}), canEdit: false }))
  .replace(open ? /(?!)/ : /<details[^>]*>(<summary>.*?<\/summary>).*?<\/details>/gs, '$1').replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'');

test('unit:e2e-tests-page-pinned — every text the tests-page case expects renders on the Tests page view its clicks open', () => {
  const steps = JSON.parse(readFileSync('e2e/cases/tests-page.json', 'utf8')).steps.filter((step: any) => step.kind === 'browser');
  let view: 'matrix' | 'cases' | null = null, open = false, checked = 0;
  for (const step of steps) {
    if (step.action === 'click' && step.text === 'Tests') view = 'matrix';
    if (step.action === 'click' && step.text === 'By item and criterion') view = 'cases';
    if (step.action === 'click' && view === 'cases' && step.text !== 'By item and criterion') {
      assert.ok(text(view).includes(step.text), `the cases view renders "${step.text}" to click`);
      open = true;
    }
    if (step.action !== 'expectText' || !view) continue;
    assert.ok(text(view, open).includes(step.text), `the ${view} view renders "${step.text}"`);
    checked++;
  }
  assert.ok(checked >= 3, 'the case checks the heading, the description and the folded items');
});
