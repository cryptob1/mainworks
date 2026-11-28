import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkPage from '../web/pages/work.js';
import { workFixture } from './helpers/work-fixture.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-4093: since GY-3600 Work groups tasks by goal with a "No goal" fold instead of per-stage
// details.group-backlog folds, so e2e:project-name-header timed out waiting for
// locator('details.group-backlog>summary'). Searching by {{itemKey}} filters Work to the created
// item, leaving No goal open even on installs with goals and >50 items.

const NOW = Date.parse('2030-06-01T12:30:00Z');
const at = new Date(NOW - 600_000).toISOString();
const backlogItem = workFixture({
  id: 'w-1', key: 'GY-9', title: 'E2E case project-name-header run r1', type: 'feature', priority: 3,
  criteria: [], policy: { checks: ['test'], review: true }, stage: 'backlog', epoch: 0, gates: [],
  createdAt: at, updatedAt: at, stageEnteredAt: at,
});
const goalItem = workFixture({
  id: 'w-2', key: 'GY-10', title: 'Goal-backed task', goal: 'GOAL-1', type: 'feature', priority: 2,
  criteria: [], policy: { checks: ['test'], review: true }, stage: 'build', epoch: 1, gates: [],
  createdAt: at, updatedAt: at, stageEnteredAt: at,
});
const board = {
  groups: {
    backlog: [{ id: backlogItem.id, key: backlogItem.key, group: 'backlog', who: 'Master agent', does: 'Not released yet', since: at }],
    moving: [{ id: goalItem.id, key: goalItem.key, group: 'moving', who: 'Builder', does: 'Building', since: at }],
  },
};

const renderWork = (query: string) => renderToStaticMarkup(createElement(WorkPage, {
  work: [backlogItem, goalItem], board, status: {}, observedAt: NOW, query, filter: null,
  setFilter: () => {}, setQuery: () => {}, setSelected: () => {}, setCreating: () => {}, setView: () => {},
} as unknown as Dashboard));

test('unit:e2e-project-name-header-pinned — the case finds the created item via Work search instead of the removed details.group-backlog fold', () => {
  const unfiltered = renderWork('');
  assert.doesNotMatch(unfiltered, /<details[^>]*group-backlog/, 'Work no longer renders a details.group-backlog fold');
  assert.match(unfiltered, /aria-label="Search work"/, 'Work renders the Search work input');

  const filtered = renderWork(backlogItem.key);
  assert.match(filtered, /<details class="panel goal-group" data-goal="none" open="">/, 'searching by item key leaves the No goal fold open even when other items have goals');
  assert.match(filtered, /data-row="GY-9"/, 'the created item row renders under the search');
  assert.match(filtered, /class="card-open"/, 'the row title link uses .card-open to open the item page');

  const steps = JSON.parse(readFileSync('e2e/cases/project-name-header.json', 'utf8')).steps as { kind: string; name: string; run?: string }[];
  const commandSteps = steps.filter(step => step.kind === 'command');
  assert.equal(commandSteps.length, 2, 'project-name-header checks desktop (1280px) and narrow (390px) viewports');
  for (const step of commandSteps) {
    assert.ok(step.run, `${step.name} has a script`);
    assert.doesNotMatch(step.run, /group-backlog/, `${step.name} must not click the removed details.group-backlog fold`);
    assert.match(step.run, /getByLabel\('Search work'\)\.fill\('\{\{itemKey\}\}'\)/, `${step.name} filters Work by the created item key`);
    assert.match(step.run, /\[data-row="\{\{itemKey\}\}"\] \.card-open/, `${step.name} opens the item row via .card-open`);
  }
});
