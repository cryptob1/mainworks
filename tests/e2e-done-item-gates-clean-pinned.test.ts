import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkPage from '../web/pages/work.js';
import type { Work } from '../src/model/work.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-3377: a bare text locator's first match was a header line naming the item, so the click opened
// nothing and "Technical details" never appeared. Since GY-3600 the case filters Work to Shipped today and
// clicks the row's title link, which opens the item page.

const NOW = Date.parse('2030-06-01T12:30:00Z'); // half past, so the minute-old merge is today in every zone
const run = 'r1-1';
const title = `E2E case done-item-gates-clean run ${run}`;
const gates = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'].map(name => ({ name, passed: true, reasons: [] as string[] }));
const item = {
  id: 'w-1', key: 'GY-9', title, type: 'chore', description: '', priority: 1, dependencies: [], criteria: [], policy: { checks: [], review: true },
  stage: 'done', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null, workspaces: [], submission: null, candidate: null,
  reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates, violations: [],
  delivery: { mergedAt: new Date(NOW - 60_000).toISOString(), mergeSha: 'a'.repeat(40), authorizationRevision: 1 },
  createdAt: new Date(NOW - 3_600_000).toISOString(), updatedAt: new Date(NOW).toISOString(), stageEnteredAt: new Date(NOW).toISOString(),
} as unknown as Work;

test('unit:e2e-done-item-gates-clean-pinned — the case opens the delivered item from its Shipped today row\'s title link', () => {
  const html = renderToStaticMarkup(createElement(WorkPage, { work: [item], board: null, status: {}, observedAt: NOW, query: '', filter: 'shipped-today', setFilter: () => {}, setQuery: () => {}, setSelected: () => {}, setCreating: () => {}, setView: () => {} } as unknown as Dashboard));
  const steps = JSON.parse(readFileSync('e2e/cases/done-item-gates-clean.json', 'utf8')).steps as { action: string; text?: string; role?: string }[];
  assert.ok(steps.some(step => step.action === 'click' && step.role === 'button' && step.text === 'Shipped today'), 'the case filters Work to Shipped today');
  assert.match(html, /data-filter="shipped-today">Shipped today <span class="count">1<\/span>/);
  const open = steps.find(step => step.action === 'click' && step.text?.includes('{{run}}'))!;
  assert.equal(open.role, 'link');
  const text = open.text!.replace('{{run}}', run);
  // The runner takes the first link naming the text: the row's title.
  const at = html.indexOf(`>${text}</a>`);
  assert.ok(at >= 0, 'the Shipped today row shows the delivered item');
  assert.match(html.slice(html.lastIndexOf('<a', at), at), /href="#GY-9"/, 'its title links to the item page');
});
