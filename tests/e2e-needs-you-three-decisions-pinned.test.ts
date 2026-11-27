import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkPage from '../web/pages/work.js';
import { workFixture } from './helpers/work-fixture.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-3969: since GY-3600 Work pins Needs you on top as a strip, not a group to open, so the case's
// "open the Needs you group" click found no button and timed out. Every button the case clicks on
// Work, after signing in and up to opening the Needs you page, must render there.

const NOW = Date.parse('2030-06-01T12:30:00Z');
const at = new Date(NOW - 600_000).toISOString();
const parks = [['w-3', 'GY-ELOGIN', 'Provider account for the export'], ['w-4', 'GY-EGOAL', 'Choose the next goal for the export']];
const work = parks.map(([id, key, title]) => workFixture({ id, key, title, type: 'feature', priority: 2, criteria: [], policy: { checks: [], review: true }, stage: 'ready', epoch: 1, gates: [],
  createdAt: at, updatedAt: at, stageEnteredAt: at }));
const board = { groups: { 'needs-you': parks.map(([id, key]) => ({ id, key, group: 'needs-you', who: 'You', does: `Answer ${key}`, since: at })) } };

test('unit:e2e-needs-you-three-decisions-pinned — every button the case clicks on Work renders there', () => {
  const html = renderToStaticMarkup(createElement(WorkPage, { work, board, status: {}, observedAt: NOW, query: '', filter: null, setFilter: () => {}, setQuery: () => {}, setSelected: () => {}, setCreating: () => {}, setView: () => {} } as unknown as Dashboard));
  const buttons = [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => match[1].replace(/<[^>]+>/g, ''));
  const steps = JSON.parse(readFileSync('e2e/cases/needs-you-three-decisions.json', 'utf8')).steps as { kind: string; action?: string; role?: string; text?: string }[];
  const clicks = steps.filter(step => step.kind === 'browser' && step.action === 'click' && step.role === 'button');
  const from = clicks.findIndex(step => step.text === 'Open control plane'), to = clicks.findIndex(step => step.text === 'Every request and answer');
  assert.ok(from >= 0 && to > from, 'the case signs in, then opens the Needs you page from Work');
  for (const step of clicks.slice(from + 1, to + 1)) assert.ok(buttons.some(text => text.includes(step.text!)), `Work renders a "${step.text}" button`);
});
