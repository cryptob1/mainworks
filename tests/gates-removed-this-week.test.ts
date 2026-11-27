import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate.js';
import { lessonsToCode } from '../src/daemon/lessons-to-code.js';
import { lessonCommand } from '../src/master/lessons.js';
import { readProjectMemory, writeProjectMemory } from '../src/project-memory.js';
import { masterLessons } from '../src/model/project-memory.js';
import type { Principal, Work } from '../src/model.js';
import TopBar from '../web/components/top-bar';
import { listen } from './helpers/http-server.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { api, apiOk } from './helpers/api.js';

// GY-3399: after a lesson-to-code item is delivered and its lesson removed, the dashboard header
// shows gates removed this week beside reverts this week, each count linking to its items — read
// from the real control plane's /api/status over the checkout's gate record and project memory.

const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(32)}`;
let store: Store, close: (() => Promise<void>) | undefined, url: string, root: string;
// The item the loop files carries an e2e proof, so the policy in force says how a head is served for
// it; the policy is read once per process, and nothing reads it ahead of this line.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

before(async () => {
  root = await temporaryDirectory('gates-removed-root');
  process.env.GRAPHYARD_REPOSITORY_ROOT = root;
  store = await withDatabase('gates-removed-this-week'); await store.init();
  ({ url, close } = await listen(server(new Engine(store, 120, 'owner/game'), [{ ...operator, token }])));
});
after(async () => { await close?.(); if (store) await store.close(); delete process.env.GRAPHYARD_REPOSITORY_ROOT; });

const call = (path: string, body?: unknown) => apiOk(url, token, path, { body });
const header = (status: unknown, work: Work[], opened: string[] = []) =>
  renderToStaticMarkup(createElement(TopBar, { view: 'work', setView: () => {}, setSelected: (id: string) => opened.push(id), status, selected: null, features: {}, work, observedAt: Date.now() } as unknown as Parameters<typeof TopBar>[0]));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('e2e:gates-removed-this-week — a delivered lesson-to-code item removes its lesson and the header shows gates removed this week beside reverts this week, linking to the items', async () => {
  // Before anything: both counts read zero, and the header shows no week line (GY-3483).
  let status = await call('status');
  assert.deepEqual(status.thisWeek, { reverts: 0, revertedItems: [], gatesRemoved: 0, gatesRemovedItems: [] });
  assert.ok(!header(status, []).includes('week-line'), 'no week line while both counts are zero');

  // The master marks a lesson enforceable; the loop's pass files its item through the real control plane.
  const deps = { status: async () => ({ actor: { id: 'graphyard-master', role: 'coordinator' } }) };
  const lesson = (await lessonCommand(root, 'graphyard-master', ['add', 'Never import from src/server inside src/model', '--enforceable'], deps) as { recorded: { id: string } }).recorded;
  const memory = await readProjectMemory(root);
  await lessonsToCode(memory, [], Date.now(), async (input, key) => (await api(url, token, 'work', { body: input, key })).body as { key?: string }, () => {});
  const filed = masterLessons(memory).find(entry => entry.id === lesson.id)!.filedAs!;
  assert.match(filed, /^GY-\d+$/, 'the pass filed a real item');

  // A batch-gate revert this week, of another real item.
  const culprit = await call('work', { type: 'chore', why: 'w', simplest: 's', title: 'A change the batch gate reverted', criteria: [{ id: 'AC-1', text: 'Kept', proofs: ['unit:kept', 'e2e:smoke'] }] });
  await writeGateRecord(gateRecordPath(root), { ...bootstrapGate('owner/game', 'c'.repeat(40)), reverts: [{ item: culprit.key, at: new Date().toISOString() }] });

  // The item is delivered: the next pass removes the lesson, and the loop mirrors its memory to the file.
  const delivered = { id: 'delivered', key: filed, stage: 'done', delivery: { mergedAt: new Date().toISOString(), mergeSha: 'a'.repeat(40) } } as unknown as Work;
  await lessonsToCode(memory, [delivered], Date.now(), undefined, () => {});
  assert.equal(masterLessons(memory).length, 0, 'the lesson left memory');
  await writeProjectMemory(root, memory);

  status = await call('status');
  assert.deepEqual(status.thisWeek, { reverts: 1, revertedItems: [culprit.key], gatesRemoved: 1, gatesRemovedItems: [filed] });
  const work = (await call('work-snapshot')).work as Work[];
  const html = header(status, work);
  assert.match(text(html), new RegExp(`This week: 1 revert ${culprit.key} · 1 gate removed ${filed}`), 'one line: the two counts side by side, each naming its items');
  const line = /<p class="week-line" data-reverts="1" data-gates-removed="1">(.*?)<\/p>/.exec(html);
  assert.ok(line, 'the header carries the week line');
  assert.ok(line![1].includes(`href="#${filed}"`) && line![1].includes(`href="#${culprit.key}"`), 'each item is a link');
  assert.ok(work.some(item => item.key === filed) && work.some(item => item.key === culprit.key), 'the linked items are the real items the dashboard opens');
});
