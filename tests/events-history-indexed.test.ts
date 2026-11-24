import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import type { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { eventHistorySql, parseEventHistoryQuery } from '../src/events-history.js';

// GY-3760: the events history page left the routine kinds out by scanning backward through every
// newer row, so on a ledger of millions of heartbeats it took 17 s. Two partial indexes on the
// rows that are not routine answer the default page and one item's page by index.
const adminToken = `operator-${'a'.repeat(32)}`;
const ITEMS = 2000, EVENTS = 2_000_000, KEPT = 700, OTHERS = 20_000, ITEM_ROUTINE = 50_000;
let store: Store, http: ReturnType<typeof server>, url: string, id: string;
let kept: string[] = [];

const get = async (path: string) => {
  const started = performance.now();
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(60_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return { body, ms: performance.now() - started };
};

before(async () => {
  store = await withDatabase('events-history-indexed'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Watched item', why: 'Its history is mostly heartbeats.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  ({ id } = await created.json() as { id: string });
  const template = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document;
  await store.pool.query(`INSERT INTO work_items(id, document) SELECT g.id, $1::jsonb || jsonb_build_object('id', g.id::text, 'key', 'GY-' || (g.n + 100))
    FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${ITEMS - 1}) n) g`, [template]);
  await store.pool.query('ALTER TABLE events SET UNLOGGED');
  const others = `(SELECT array_agg(id) AS ids FROM work_items WHERE id <> '${id}') i`;
  // Oldest: the watched item's rows worth reading. Then the rest of the install's, and then millions of routine rows,
  // the watched item's own heartbeats among them, so neither page finds its rows near the newest end of the ledger.
  kept = (await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT $1, 'fixture', (ARRAY['reconciled','session','action.claimed'])[1 + d % 3],
    jsonb_build_object('details', jsonb_build_object('step', d)) FROM generate_series(1, ${KEPT}) d RETURNING seq`, [id])).rows.map(row => String(row.seq));
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT ids[1 + d % array_length(ids, 1)], 'fixture', (ARRAY['reconciled','session','action.claimed'])[1 + d % 3], '{"details":{"n":1}}'::jsonb
    FROM ${others}, generate_series(1, ${OTHERS}) d`);
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT $1, 'fixture', (ARRAY['heartbeat','github.observed'])[1 + d % 2], '{"details":{"n":1}}'::jsonb
    FROM generate_series(1, ${ITEM_ROUTINE}) d`, [id]);
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT ids[1 + d % array_length(ids, 1)], 'fixture', (ARRAY['heartbeat','github.observed'])[1 + d % 2], '{"details":{"n":1}}'::jsonb
    FROM ${others}, generate_series(1, ${EVENTS - ITEM_ROUTINE - OTHERS - KEPT}) d`);
  await store.pool.query('ANALYZE events');
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await store?.close();
});

const plan = async (text: string, values: unknown[]) => (await store.pool.query(`EXPLAIN ${text}`, values)).rows.map(row => row['QUERY PLAN']).join('\n');

test('integration:events-history-indexed — the default events page and one item\'s page read by index in under a second on two million mostly routine events, with the same rows and paging', { timeout: 600_000 }, async () => {
  assert.ok(Number((await store.pool.query('SELECT count(*) FROM events')).rows[0].count) >= EVENTS);

  // The plans: the default page through events_history, one item's page through one of the two partial indexes; no table scan.
  const all = eventHistorySql(parseEventHistoryQuery(new URLSearchParams()));
  const allPlan = await plan(all.text, all.values);
  assert.doesNotMatch(allPlan, /Seq Scan/, allPlan);
  assert.match(allPlan, /Index (Only )?Scan Backward using events_history /, allPlan);
  const item = eventHistorySql(parseEventHistoryQuery(new URLSearchParams({ work: id })));
  const itemPlan = await plan(item.text, item.values);
  assert.doesNotMatch(itemPlan, /Seq Scan/, itemPlan);
  assert.match(itemPlan, /Index (Only )?Scan Backward using events_(work_)?history /, itemPlan);

  // Warm the connection and caches once, then each page answers in under a second.
  await get('events'); await get(`events?work=${id}`);
  const first = await get('events?view=history');
  assert.ok(first.ms < 1000, `the default events page took ${Math.round(first.ms)} ms`);
  const itemPage = await get(`events?work=${id}&view=page`);
  assert.ok(itemPage.ms < 1000, `one item's events page took ${Math.round(itemPage.ms)} ms`);

  // The same rows, newest first, payload resolved, as a read that names the kinds it wants returns; the cursor walks on.
  const expected = (await store.pool.query(`SELECT seq FROM events WHERE kind IN ('reconciled','session','action.claimed') ORDER BY seq DESC LIMIT 900`)).rows.map(row => String(row.seq));
  const seqs = (rows: { seq: string }[]) => rows.map(row => row.seq);
  assert.deepEqual(seqs(first.body.events), expected.slice(0, 300));
  assert.ok(first.body.events.every((row: { kind: string; payload: unknown }) => row.kind !== 'heartbeat' && row.kind !== 'github.observed' && row.payload));
  assert.equal(first.body.page.hasMore, true);
  assert.ok(first.body.routine.total > 0, first.body.routine.statement);
  const second = await get(`events?view=page&cursor=${first.body.page.nextCursor}`);
  assert.deepEqual(seqs(second.body.events), expected.slice(300, 600));
  const third = await get(`events?view=page&cursor=${second.body.page.nextCursor}`);
  assert.deepEqual(seqs(third.body.events), expected.slice(600, 900));
  // The item's own rows from its creation through its last row worth reading; its heartbeats all came later.
  const newest = (await store.pool.query('SELECT seq FROM events WHERE work_id=$1 AND seq<=$2 ORDER BY seq DESC', [id, kept.at(-1)])).rows.map(row => String(row.seq));
  assert.ok(newest.length > 300);
  assert.deepEqual(seqs(itemPage.body.events), newest.slice(0, 300));
  assert.equal(itemPage.body.events[0].payload.details.step, KEPT);
  const itemNext = await get(`events?work=${id}&view=page&cursor=${itemPage.body.page.nextCursor}&limit=1000`);
  assert.deepEqual(seqs(itemNext.body.events), newest.slice(300));
  assert.equal(itemNext.body.page.hasMore, false);
  const ascending = await get(`events?work=${id}&view=page&order=asc&limit=5`);
  assert.deepEqual(seqs(ascending.body.events), [...newest].reverse().slice(0, 5));
});
