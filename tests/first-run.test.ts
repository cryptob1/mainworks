import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { draftFirstRunTask, firstRunState, hasMergedWork, selectSmallIssues } from '../src/model/first-run.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import FirstRunPage from '../web/pages/first-run.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import type { Work } from '../src/model.js';

test('unit:first-run — selectSmallIssues prefers up to 3 small-labelled open issues, falls back to 3 shortest bodies, and excludes PRs', () => {
  const withSmall = selectSmallIssues([
    { number: 1, title: 'Large task', body: 'x', labels: [{ name: 'feature' }], state: 'open' },
    { number: 2, title: 'Small one', body: 'medium body text', labels: [{ name: 'small' }], state: 'open' },
    { number: 3, title: 'PR', body: '', labels: [{ name: 'small' }], state: 'open', pull_request: {} },
    { number: 4, title: 'Closed small', body: '', labels: [{ name: 'small' }], state: 'closed' },
    { number: 5, title: 'Good first issue', body: 'short', labels: [{ name: 'good first issue' }], state: 'open' },
    { number: 6, title: 'Size XS', body: 'tiny', labels: [{ name: 'size: xs' }], state: 'open' },
    { number: 7, title: 'Fourth small', body: 'very long small description that should drop', labels: [{ name: 'small' }], state: 'open' },
  ]);
  assert.deepEqual(withSmall.map(i => i.number), [6, 5, 2]);

  const fallback = selectSmallIssues([
    { number: 10, title: 'Long', body: 'a'.repeat(50), state: 'open' },
    { number: 11, title: 'Short A', body: 'hi', state: 'open' },
    { number: 12, title: 'Empty', body: null, state: 'open' },
    { number: 13, title: 'Short B', body: 'hey', state: 'open' },
    { number: 14, title: 'Medium', body: 'a'.repeat(20), state: 'open' },
  ]);
  assert.deepEqual(fallback.map(i => i.number), [12, 11, 13]);
});

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

  assert.equal(hasMergedWork([]), false);
  assert.equal(hasMergedWork([{ stage: 'done', delivery: { mergedAt: '2026-11-22T00:00:00Z' } } as unknown as Work]), true);
});

test('unit:first-run — draftFirstRunTask drafts why, simplest, and an e2e: proof criterion for issues and free text', () => {
  const fromIssue = draftFirstRunTask({ issue: { number: 88, title: 'Fix port flag', body: 'Add --port', labels: ['small'], url: null } });
  assert.equal(fromIssue.title, 'Fix port flag');
  assert.ok(fromIssue.why.length > 0 && fromIssue.simplest.length > 0);
  assert.deepEqual(fromIssue.criteria[0].proofs, ['e2e:issue-88']);

  const fromText = draftFirstRunTask({ text: 'The footer year is hard-coded' });
  assert.equal(fromText.title, 'The footer year is hard-coded');
  assert.ok(fromText.criteria[0].proofs[0].startsWith('e2e:'));
});

test('unit:first-run — GET /api/first-run/issues returns up to 3 small open issues and FirstRunPage renders cleanly', async () => {
  const store = await withDatabase('first-run-issues');
  await store.init();
  const engine = new Engine(store, 120, 'owner/repo');
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'op', role: 'admin', token: 'tok' }], {
    listOpenIssues: async () => [
      { number: 1, title: 'One', body: 'aaa', labels: [{ name: 'small' }], state: 'open' },
      { number: 2, title: 'Two', body: 'b', labels: [{ name: 'small' }], state: 'open' },
    ],
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const port = (http.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/first-run/issues`, { headers: { Authorization: 'Bearer tok' } });
    assert.equal(response.status, 200);
    const body = await response.json() as { issues: { number: number }[] };
    assert.deepEqual(body.issues.map(i => i.number), [2, 1]);
    const post = async (path: string, payload: unknown, key: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 200);
      return await res.json() as Work;
    };
    const created = await post(
      'work',
      draftFirstRunTask({ issue: { number: 88, title: 'Fix port flag', body: 'Add --port', labels: ['small'], url: null } }),
      'first-run-test-create',
    );
    const activeWork = await post(
      `work/${encodeURIComponent(created.id)}/ready`,
      { expectedRevision: created.revision, reason: 'Started from first-run setup' },
      'first-run-test-ready',
    );
    const noop = () => {};
    const renderStep = (status: any, work: Work[] = []) => renderToStaticMarkup(createElement(FirstRunPage, {
      token: 'tok', work, board: null, status, error: '', connected: true, lastUpdated: null,
      view: 'home', setView: noop, filter: null, setFilter: noop, selected: null, setSelected: noop, creating: false, setCreating: noop,
      busy: false, setBusy: noop, observedAt: Date.now(), jobs: [], query: '', setQuery: noop, operatorAgents: [], operatorAgentsError: null,
      features: { validation: null, releases: null, automation: null, scenarios: null }, events: [], editingRequirements: false, setEditingRequirements: noop,
      sessionEpoch: { current: 0 }, api: async () => ({}), refresh: async () => {}, action: async () => {}, setError: noop, signOut: noop,
    } as Dashboard));

    const step1 = renderStep({ repository: null, actor: { id: 'op', role: 'admin' } });
    assert.match(step1, /Connect a repository/);
    assert.match(step1, /mainworks up --repo OWNER\/NAME/);
    assert.doesNotMatch(step1, /npx mainworks/);

    const step2 = renderStep({ repository: 'owner/repo', actor: { id: 'op', role: 'admin' }, fleet: { roles: [], accounts: [] } });
    assert.match(step2, /mainworks master registry propose --apply/);
    assert.doesNotMatch(step2, /npx mainworks/);

    const passingFleet = {
      roles: [{ role: 'worker', accounts: ['claude-a'] }],
      accounts: [{ name: 'claude-a', runtime: 'claude', modelId: 'claude-opus-5-5', host: 'box', enabled: true, loggedIn: true, eligible: true, smoke: { result: 'pass', reason: null } }],
    };
    const step3 = renderStep({ repository: 'owner/repo', actor: { id: 'op', role: 'admin' }, fleet: passingFleet });
    assert.match(step3, /mainworks create task\.json/);
    assert.match(step3, /mainworks ready GY-1/);
    assert.doesNotMatch(step3, /npx mainworks/);

    const step4 = renderStep({ repository: 'owner/repo', actor: { id: 'op', role: 'admin' }, fleet: passingFleet }, [activeWork]);
    assert.match(step4, /data-first-run-step="4"/);
    assert.match(step4, /Fix port flag/);
    assert.match(step4, new RegExp(`mainworks status ${activeWork.key}`));
    assert.doesNotMatch(step4, /npx mainworks/);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await store.close();
  }
});
