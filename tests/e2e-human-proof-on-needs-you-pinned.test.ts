import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkPage from '../web/pages/work.js';
import HumanRequestsPage from '../web/pages/human-requests.js';
import { workFixture } from './helpers/work-fixture.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-4108: since GY-3600 Work pins Needs you on top as a strip, not a group to open, so the
// human-proof-on-needs-you case's "open the Needs you group" click found no button and timed out.
// Every button the case clicks on Work after signing in and before opening the item must render
// on Work, and the Needs you page must render the item's title to open it.

const NOW = Date.parse('2030-06-01T12:30:00Z');
const at = new Date(NOW - 600_000).toISOString();
const item = workFixture({
  id: 'w-hp',
  key: 'GY-EHP',
  title: 'E2E case human-proof-on-needs-you run 1',
  type: 'chore',
  priority: 3,
  criteria: [{ id: 'AC-1', text: 'A receipt prints on the shop printer', proofs: ['human:receipt-prints'] }],
  policy: { checks: ['test'], review: true },
  stage: 'backlog',
  epoch: 0,
  gates: [],
  humanProofs: [{
    id: 'hp-1',
    proof: 'human:receipt-prints',
    criterion: 'AC-1',
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    policyRevision: 1,
    ask: 'A receipt prints on the shop printer',
    steps: ['Open https://preview.example/check/', 'Make this check on commit aaaaaaaaaaaa'],
    at,
    requestedBy: 'e2e-operator',
    answer: null,
  }],
  createdAt: at,
  updatedAt: at,
  stageEnteredAt: at,
});
const board = { groups: { 'needs-you': [{ id: item.id, key: item.key, group: 'needs-you', who: 'You', does: 'Check human:receipt-prints', since: at }] } };
const dashboard = { work: [item], board, status: {}, observedAt: NOW, query: '', filter: null, setFilter: () => {}, setQuery: () => {}, setSelected: () => {}, setCreating: () => {}, setView: () => {}, action: async () => {}, busy: false, signOut: () => {} } as unknown as Dashboard;

test('unit:e2e-human-proof-on-needs-you-pinned — every button the case clicks on Work renders there and Needs you lists the item', () => {
  const workHtml = renderToStaticMarkup(createElement(WorkPage, dashboard));
  const buttons = [...workHtml.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  const steps = JSON.parse(readFileSync('e2e/cases/human-proof-on-needs-you.json', 'utf8')).steps as { kind: string; action?: string; role?: string; text?: string }[];
  const from = steps.findIndex(step => step.kind === 'browser' && step.action === 'click' && step.text === 'Open control plane');
  const to = steps.findIndex(step => step.kind === 'browser' && step.action === 'click' && step.text?.includes('E2E case'));
  assert.ok(from >= 0 && to > from, 'the case signs in, navigates from Work to Needs you, then opens the item');
  const navClicks = steps.slice(from + 1, to).filter(step => step.kind === 'browser' && step.action === 'click' && step.role === 'button');
  assert.ok(navClicks.length > 0, 'the case clicks a button on Work to reach Needs you');
  for (const step of navClicks) assert.ok(buttons.some(text => text.includes(step.text!)), `Work renders a "${step.text}" button`);

  const needsYouHtml = renderToStaticMarkup(createElement(HumanRequestsPage, dashboard));
  assert.ok(needsYouHtml.includes(item.title), 'Needs you renders the item title so the case can open it');
});
