import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { firstRunState, hasMergedWork } from '../src/model/first-run.js';
import FirstRunPage from '../web/pages/first-run.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import type { Work } from '../src/model.js';
import { workFixture } from './helpers/work-fixture.js';

test('unit:first-run — step 2 passes only after a live request answers on a registered model id and surfaces provider errors', () => {
  const noRepo = firstRunState({ repository: null }, []);
  assert.equal(noRepo.currentStep, 1);
  assert.equal(noRepo.step1Done, false);

  const noSmoke = firstRunState({
    repository: 'owner/repo',
    fleet: {
      roles: [{ role: 'worker', accounts: ['claude-a'] }],
      accounts: [{ name: 'claude-a', runtime: 'claude', modelId: 'claude-opus-5-5', host: 'box', enabled: true, loggedIn: true, eligible: true, smoke: null }],
    },
  }, []);
  assert.equal(noSmoke.currentStep, 2);
  assert.equal(noSmoke.step1Done, true);
  assert.equal(noSmoke.step2Done, false);

  const failedSmoke = firstRunState({
    repository: 'owner/repo',
    fleet: {
      roles: [{ role: 'worker', accounts: ['claude-a'] }],
      accounts: [{ name: 'claude-a', runtime: 'claude', modelId: 'claude-opus-5-5', host: 'box', enabled: true, loggedIn: true, eligible: false, smoke: { result: 'fail', reason: 'Invalid API key.' } }],
    },
  }, []);
  assert.equal(failedSmoke.currentStep, 2);
  assert.equal(failedSmoke.step2Done, false);
  assert.equal(failedSmoke.builder?.error, 'Invalid API key.');

  const passed = firstRunState({
    repository: 'owner/repo',
    fleet: {
      roles: [{ role: 'worker', accounts: ['claude-a'] }],
      accounts: [{ name: 'claude-a', runtime: 'claude', modelId: 'claude-opus-5-5', host: 'box', enabled: true, loggedIn: true, eligible: true, smoke: { result: 'pass', reason: null } }],
    },
  }, []);
  assert.equal(passed.currentStep, 3);
  assert.equal(passed.step2Done, true);
  assert.equal(passed.builder?.modelId, 'claude-opus-5-5');

  const hostChecked = firstRunState({
    repository: 'owner/repo',
    fleet: {
      roles: [{ role: 'worker', accounts: ['claude-a'] }],
      accounts: [{ name: 'claude-a', runtime: 'claude', modelId: 'claude-opus-5-5', host: 'box', enabled: true, loggedIn: true, eligible: true, smoke: null, checkedLive: '2026-11-23T05:00:00Z', quota: 'available' }],
    },
  }, []);
  assert.equal(hostChecked.step2Done, true, 'a host live check that found the quota available passes step 2');
  assert.equal(hostChecked.currentStep, 3);

  const hostExhausted = firstRunState({
    repository: 'owner/repo',
    fleet: {
      roles: [{ role: 'worker', accounts: ['claude-a'] }],
      accounts: [{ name: 'claude-a', runtime: 'claude', modelId: 'claude-opus-5-5', host: 'box', enabled: true, loggedIn: true, eligible: true, smoke: null, checkedLive: '2026-11-23T05:00:00Z', quota: 'exhausted', reason: 'You have hit your usage limit.' }],
    },
  }, []);
  assert.equal(hostExhausted.step2Done, false);
  assert.equal(hostExhausted.builder?.error, 'You have hit your usage limit.');

  assert.equal(hasMergedWork([]), false);
  assert.equal(hasMergedWork([{ stage: 'done', delivery: { mergedAt: '2026-11-22T00:00:00Z' } } as unknown as Work]), true);
});

test('unit:first-run — FirstRunPage renders each step with its terminal equivalent', () => {
  const noop = () => {};
  const renderStep = (status: any, work: Work[] = []) => renderToStaticMarkup(createElement(FirstRunPage, {
    token: 'tok', work, board: null, status, error: '', connected: true, lastUpdated: null,
    view: 'home', setView: noop, filter: null, setFilter: noop, selected: null, setSelected: noop, creating: false, setCreating: noop,
    busy: false, setBusy: noop, observedAt: Date.now(), jobs: [], query: '', setQuery: noop, operatorAgents: [], operatorAgentsError: null,
    features: { validation: null, releases: null, automation: null, scenarios: null }, events: [], editingRequirements: false, setEditingRequirements: noop,
    sessionEpoch: { current: 0 }, api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop,
  } as unknown as Dashboard));

  const step1 = renderStep({ repository: null, actor: { id: 'op', role: 'admin' } });
  assert.match(step1, /Connect a repository/);
  // The shared page shell (ui-shell-all-pages): one h1 inside .page-heading with its .page-fact, content in a .panel.
  assert.equal(step1.match(/<h1/g)?.length, 1);
  assert.match(step1, /<div class="page-heading"><div><h1>Connect a repository<\/h1><p class="page-fact">Step 1 of 4 · 0 done<\/p>/);
  assert.match(step1, /class="panel first-run-body"/);
  assert.match(step1, /mainworks up --repo OWNER\/NAME/);
  assert.doesNotMatch(step1, /npx mainworks/);

  const step2 = renderStep({ repository: 'owner/repo', actor: { id: 'op', role: 'admin' }, fleet: { roles: [], accounts: [] } });
  assert.match(step2, /mainworks master registry propose --apply/);

  const passingFleet = {
    roles: [{ role: 'worker', accounts: ['claude-a'] }],
    accounts: [{ name: 'claude-a', runtime: 'claude', modelId: 'claude-opus-5-5', host: 'box', enabled: true, loggedIn: true, eligible: true, smoke: { result: 'pass', reason: null } }],
  };
  const step3 = renderStep({ repository: 'owner/repo', actor: { id: 'op', role: 'admin' }, fleet: passingFleet });
  assert.match(step3, /data-first-run-step="3"/);
  assert.match(step3, /owner\/repo/);
  assert.match(step3, /claude-opus-5-5/);
  assert.match(step3, /mainworks create task\.json/);
  assert.match(step3, /mainworks ready GY-1/);

  const task = workFixture({ id: 'w1', key: 'GY-7', title: 'Fix port flag', stage: 'build' });
  const step4 = renderStep({ repository: 'owner/repo', actor: { id: 'op', role: 'admin' }, fleet: passingFleet }, [task]);
  assert.match(step4, /data-first-run-step="4"/);
  assert.match(step4, /Fix port flag/);
  assert.match(step4, /mainworks status GY-7/);
});
