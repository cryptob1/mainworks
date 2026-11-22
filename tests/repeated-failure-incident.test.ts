import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { groupRepeatedFailures, incidentsFromStatus, normaliseFailureLine, repeatedFailureGroups } from '../src/model/incidents.js';
import { HomeStatus } from '../web/components/home.js';
import type { Principal, Work } from '../src/model.js';

// GY-3626: the same failure in three sessions within 30 minutes is one incident,
// found from session results without any agent reporting it.

const minute = 60_000;
const baseNow = Date.parse('2026-11-22T15:00:00.000Z');
const ago = (ms: number, ref = baseNow) => new Date(ref - ms).toISOString();

test('unit:repeated-failure-is-one-incident — groups three distinct items with normalised lines in 30 minutes', () => {
  const same = [
    { item: 'GY-1', reason: 'CLI commit a1b2 differs from server c3d4', at: ago(5 * minute) },
    { item: 'GY-2', reason: 'CLI commit e5f6 differs from server 90ab', at: ago(10 * minute) },
    { item: 'GY-3', reason: 'CLI commit 12cd differs from server 78ef', at: ago(15 * minute) },
  ];
  const groups = groupRepeatedFailures(same, baseNow);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].line, 'CLI commit differs from server');
  assert.equal(groups[0].count, 3);
  assert.deepEqual(groups[0].items, ['GY-1', 'GY-2', 'GY-3']);

  // Two distinct items do not form a group.
  assert.deepEqual(groupRepeatedFailures(same.slice(0, 2), baseNow), []);

  // Three different failures do not form a group.
  assert.deepEqual(groupRepeatedFailures([
    { item: 'GY-1', reason: 'CLI commit a1b2 differs from server c3d4', at: ago(5 * minute) },
    { item: 'GY-2', reason: 'Free usage limit reached', at: ago(6 * minute) },
    { item: 'GY-3', reason: 'Connection reset by peer', at: ago(7 * minute) },
  ], baseNow), []);

  // The same item failing three times does not form a group.
  assert.deepEqual(groupRepeatedFailures([
    { item: 'GY-1', reason: 'CLI commit a1b2 differs from server c3d4', at: ago(5 * minute) },
    { item: 'GY-1', reason: 'CLI commit e5f6 differs from server 90ab', at: ago(10 * minute) },
    { item: 'GY-1', reason: 'CLI commit 12cd differs from server 78ef', at: ago(15 * minute) },
  ], baseNow), []);
});

test('unit:repeated-failure-is-one-incident — removes item keys, hashes, temp path parts and numbers, and clears after 30 minutes', () => {
  assert.equal(
    normaliseFailureLine('GY-3626 failed at /tmp/graphyard-trial-a1b2c3/src/foo.ts:42 (exit 1)\nstack trace'),
    normaliseFailureLine('GY-9999 failed at /tmp/graphyard-trial-d4e5f6/src/foo.ts:98 (exit 2)\nother trace'),
  );
  assert.equal(
    normaliseFailureLine('Error in /home/vish/code/.graphyard/worktrees/GY-10-1/src/a.ts:12'),
    normaliseFailureLine('Error in /home/vish/code/.graphyard/worktrees/GY-20-3/src/a.ts:88'),
  );

  // Failures older than 30 minutes fall out of the window.
  const entries = [
    { item: 'GY-1', reason: 'Free usage limit reached', at: ago(31 * minute) },
    { item: 'GY-2', reason: 'Free usage limit reached', at: ago(10 * minute) },
    { item: 'GY-3', reason: 'Free usage limit reached', at: ago(5 * minute) },
  ];
  assert.deepEqual(groupRepeatedFailures(entries, baseNow), []);

  // Sources on Work: failed session exit, trial failure, and rework reason combine across distinct items,
  // while benign session closures are ignored.
  const work = [
    { id: '1', key: 'GY-1', title: 'One', stage: 'build', stageEnteredAt: ago(10 * minute), updatedAt: ago(10 * minute), lease: null, dependencies: [],
      sessions: [
        { id: 's1', kind: 'implementation', state: 'finished', endedAt: ago(5 * minute), updatedAt: ago(5 * minute), outcome: 'Free usage limit reached' },
        { id: 's2', kind: 'implementation', state: 'finished', endedAt: ago(4 * minute), updatedAt: ago(4 * minute), outcome: 'ended: delivered' },
      ] },
    { id: '2', key: 'GY-2', title: 'Two', stage: 'test', stageEnteredAt: ago(10 * minute), updatedAt: ago(6 * minute), lease: null, dependencies: [],
      mergeLedger: { state: 'refused', refusal: { kind: 'merge', reason: 'Free usage limit reached\ndetails' }, trialStep: { step: 'tests', at: ago(6 * minute) } } },
    { id: '3', key: 'GY-3', title: 'Three', stage: 'ready', stageEnteredAt: ago(10 * minute), updatedAt: ago(7 * minute), lease: null, dependencies: [],
      lastRework: { reason: 'Free usage limit reached', binding: null, at: ago(7 * minute) } },
  ] as unknown as Work[];
  const groups = repeatedFailureGroups(work, baseNow);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].line, 'Free usage limit reached');
  assert.deepEqual(groups[0].items, ['GY-1', 'GY-2', 'GY-3']);

  // Home incident card says 'the caretaker is looking' until an open item is filed for the fault.
  const [unfiled] = incidentsFromStatus({}, work, baseNow);
  assert.equal(unfiled.kind, 'repeated-failure');
  assert.match(unfiled.broke, /Free usage limit reached/);
  assert.match(unfiled.broke, /3 items/);
  assert.match(unfiled.doing, /the caretaker is looking/);

  const filedItem = { id: '4', key: 'GY-4', title: 'Fix Free usage limit reached across workers', description: 'Caretaker filed', stage: 'ready', stageEnteredAt: ago(2 * minute), updatedAt: ago(2 * minute), lease: null, dependencies: [] } as unknown as Work;
  const [filed] = incidentsFromStatus({}, [...work, filedItem], baseNow);
  assert.equal(filed.kind, 'repeated-failure');
  assert.match(filed.doing, /GY-4/);
  assert.deepEqual(filed.action, { label: 'Open the item', open: 'item', item: '4' });
});

const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'r'.repeat(32)}`;
let store: Store, http: ReturnType<typeof server>, url: string;

before(async () => {
  store = await withDatabase('repeated-failure-incident');
  await store.init();
  http = server(new Engine(store, 120, 'owner/game'), [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});

after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
});

const api = async (path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${path}-${Math.random()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json() as any;
  if (!response.ok) throw new Error(`${path}: ${json?.error}`);
  return json;
};

test('e2e:repeated-failure-incident — three ended sessions with the same error produce one Home card and one attention line, and none after 30 minutes', async () => {
  const hashes = [['a1b2', 'c3d4'], ['e5f6', '7890'], ['12ab', '34cd']] as const;
  const items: Work[] = [];
  for (const [index, [cliSha, serverSha]] of hashes.entries()) {
    const item = await api('work', {
      title: `Task ${index + 1}`, why: 'Faults repeat.', simplest: 'One timer.', type: 'feature',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }],
    }) as Work;
    await api(`work/${item.id}/session`, {
      id: `worker-${index + 1}:1`, kind: 'implementation', runtime: 'claude', host: 'test-host',
      subject: `${item.key}: ${item.title}`, state: 'finished',
      outcome: `CLI commit ${cliSha} differs from server ${serverSha}`,
    });
    items.push(item);
  }

  const directory = await temporaryDirectory('repeated-failure-incident');
  const config = masterConfigSchema.parse({
    version: 1, url, repository: 'owner/game', credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main', githubAppId: 1234,
    masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 },
  });
  const root = await temporaryDirectory('repeated-failure-incident-root');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) =>
    isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`;

  const report = await masterStatusReport(root, config, api, run);
  const attention = report.attention.filter(line => line.subject === 'repeated failure');
  assert.equal(attention.length, 1);
  assert.match(attention[0].text, /CLI commit differs from server/);
  assert.match(attention[0].text, /3 items/);
  assert.match(attention[0].text, /the caretaker is looking/);

  const status = await api('status');
  const snapshot = await api('work-snapshot');
  const now = Date.parse(snapshot.now);
  const html = renderToStaticMarkup(createElement(HomeStatus, { work: snapshot.work, status, now, setView: () => {}, setSelected: () => {} }));
  assert.equal((html.match(/data-incident="repeated-failure"/g) ?? []).length, 1);
  assert.match(html, /CLI commit differs from server/);
  assert.match(html, /3 items/);
  assert.match(html, /the caretaker is looking/);

  // Age all three ended sessions past the 30-minute window and assert both clear.
  const expired = new Date(now - 31 * minute).toISOString();
  for (const item of items) {
    const stored = await api(`work/${item.id}`) as Work;
    const aged = (stored.sessions ?? []).map(session => ({ ...session, endedAt: expired, updatedAt: expired }));
    await store.pool.query('UPDATE work_items SET document = jsonb_set(document, \'{sessions}\', $2::jsonb) WHERE id=$1', [item.id, JSON.stringify(aged)]);
  }

  const afterReport = await masterStatusReport(root, config, api, run);
  assert.equal(afterReport.attention.filter(line => line.subject === 'repeated failure').length, 0);

  const afterSnapshot = await api('work-snapshot');
  const afterHtml = renderToStaticMarkup(createElement(HomeStatus, { work: afterSnapshot.work, status, now: Date.parse(afterSnapshot.now), setView: () => {}, setSelected: () => {} }));
  assert.equal((afterHtml.match(/data-incident="repeated-failure"/g) ?? []).length, 0);
});
