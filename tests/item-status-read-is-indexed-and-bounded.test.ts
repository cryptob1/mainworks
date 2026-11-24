import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import type { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { workDocumentSql } from '../src/store/bounded-snapshot.js';
import { eventHistorySql, parseEventHistoryQuery } from '../src/events-history.js';
import { boundedHistoryRead, historyReadSlots } from '../src/server/history-reads.js';
import { coordinationViewHeader } from '../src/server/work-view.js';

// GY-3757: on an install with history, watching one item — `status GY-N`, the item page — took the
// line's database away. The per-item reads answer from indexes, at most four history reads run at
// once, and the loop's own snapshot read still answers while thirty readers watch one item.
const adminToken = `operator-${'a'.repeat(32)}`, coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const ITEMS = 2000, EVENTS = 2_000_000, ITEM_ROWS = 3000;
let store: Store, http: ReturnType<typeof server>, url: string, id: string, key: string;

const get = async (token: string, path: string, headers: Record<string, string> = {}) => {
  const started = performance.now();
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(60_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return { body, ms: performance.now() - started, age: response.headers.get('age') };
};

before(async () => {
  store = await withDatabase('item-status-read-is-indexed-and-bounded'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Watched item', why: 'Many readers watch it.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  ({ id, key } = await created.json() as { id: string; key: string });
  // A long-lived document: production items carry hundreds of kilobytes of evidence and sessions.
  await store.pool.query(`UPDATE work_items SET document = document || jsonb_build_object('padding', repeat('x', 200000)) WHERE id=$1`, [id]);
  const template = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document;
  delete template.padding;
  await store.pool.query(`INSERT INTO work_items(id, document) SELECT g.id, $1::jsonb || jsonb_build_object('id', g.id::text, 'key', 'GY-' || (g.n + 100))
    FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${ITEMS - 1}) n) g`, [template]);
  // The watched item's history: one whole snapshot and thousands of saves stored as deltas on it.
  const base = (await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT id, 'fixture', 'reconciled', jsonb_build_object('work', document) FROM work_items WHERE id=$1 RETURNING seq`, [id])).rows[0].seq;
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT $1, 'fixture', (ARRAY['reconciled','session','action.claimed'])[1 + d % 3],
    jsonb_build_object('delta', jsonb_build_object('base', $2::bigint, 'revision', 1, 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('title'), 'Watched item ' || d))), 'details', jsonb_build_object('reason', 'step ' || d))
    FROM generate_series(1, ${ITEM_ROWS}) d`, [id, base]);
  // The rest of the ledger: two million rows across every other item.
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
    SELECT ids[1 + d % array_length(ids, 1)], 'fixture', (ARRAY['heartbeat','github.observed','reconciled'])[1 + d % 3], '{"details":{"n":1}}'::jsonb, now() - interval '30 days' + d * interval '1 millisecond'
    FROM (SELECT array_agg(id) AS ids FROM work_items WHERE id <> $1) i, generate_series(1, ${EVENTS}) d`, [id]);
  await store.pool.query('ANALYZE');
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await store?.close();
});

const plan = async (text: string, values: unknown[]) => (await store.pool.query(`EXPLAIN ${text}`, values)).rows.map(row => row['QUERY PLAN']).join('\n');

test('integration:item-status-read-is-indexed-and-bounded — status GY-N and the item page answer from indexes in under a second on two million events; four history reads at once, later ones get the last answer with its age, and the loop snapshot still answers', { timeout: 600_000 }, async () => {
  assert.ok(Number((await store.pool.query('SELECT count(*) FROM events')).rows[0].count) >= EVENTS);
  // The plans: the item by display key and by id through the work index's indexes; its history page through events_work.
  for (const value of [key, id]) {
    const text = await plan(workDocumentSql(value), [value]);
    assert.doesNotMatch(text, /Seq Scan/, `status ${value} reads no table whole:\n${text}`);
    assert.match(text, /work_index_key|work_index_pkey/, text);
  }
  const page = eventHistorySql(parseEventHistoryQuery(new URLSearchParams({ work: id, payload: 'details' })));
  const pagePlan = await plan(page.text, page.values);
  assert.doesNotMatch(pagePlan, /Seq Scan/, pagePlan);
  assert.match(pagePlan, /events_work/, pagePlan);

  // Each read answers in under a second (after one warm read of the connection and caches).
  await get(adminToken, `work/${key}`); await get(adminToken, `events?work=${id}&payload=details`);
  const status = await get(adminToken, `work/${key}`);
  assert.equal(status.body.key, key);
  assert.ok(status.ms < 1000, `status ${key} took ${Math.round(status.ms)} ms`);
  const history = await get(adminToken, `events?work=${id}&payload=details`);
  assert.equal(history.body.length, 300);
  assert.equal(history.body[0].details.reason, `step ${ITEM_ROWS}`);
  assert.ok(history.ms < 1000, `the item page's history took ${Math.round(history.ms)} ms`);

  // Thirty readers watch the item at once — the full-document history read old clients send, and status.
  const monitor = await store.pool.connect();
  let peak = 0, sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const active = Number((await monitor.query(`SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'SELECT seq,work_id,actor,kind,created_at%FROM events WHERE work_id=%'`)).rows[0].count);
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })();
  try {
    const readers = Array.from({ length: 30 }, (_, n) => n % 3 === 0 ? get(adminToken, `work/${key}`) : get(adminToken, `events?work=${id}`));
    await new Promise(resolve => setTimeout(resolve, 200));
    const loop = await get(coordinatorToken, 'work-snapshot', { [coordinationViewHeader]: 'coordination' });
    assert.ok(loop.body.work.some((item: { id: string }) => item.id === id));
    assert.ok(loop.ms < 2000, `the loop's snapshot read took ${Math.round(loop.ms)} ms while thirty readers watched one item`);
    const answers = await Promise.all(readers);
    for (const answer of answers) assert.ok(Array.isArray(answer.body) ? answer.body.length === 300 : answer.body.key === key);
  } finally { sampling = false; await sampler; monitor.release(); }
  assert.ok(peak <= historyReadSlots, `at most ${historyReadSlots} history queries ran at once; saw ${peak}`);
  assert.ok(peak >= 1, 'the sampler saw the history queries');

  // Every slot held: a read waits five seconds, then gets the last answer and its age.
  const held: (() => void)[] = [];
  const holders = Array.from({ length: historyReadSlots }, () => boundedHistoryRead(randomUUID(), () => new Promise<void>(resolve => held.push(resolve))));
  const started = Date.now();
  const late = await boundedHistoryRead(`/api/events?work=${id}`, async () => { throw new Error('a waiting read runs no query'); }).catch(() => null);
  held.forEach(resolve => resolve()); await Promise.all(holders);
  assert.ok(late, 'a read with a last answer is answered from it');
  const waited = Date.now() - started;
  assert.ok(waited >= 4900 && waited < 7000, `it waited ${waited} ms`);
  assert.ok(late.ageMs !== null && late.ageMs >= 4900, `the answer carries its age: ${late.ageMs}`);
});
