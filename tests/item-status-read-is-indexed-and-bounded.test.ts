import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { planAsRows, withDatabase } from './helpers/postgres.js';
import { explainAnalyzeBuffers } from './helpers/query-plan.js';
import type { Store } from '../src/store.js';
import { coordinationDocumentSql, coordinationRelevance, coordinationTail, coordinationTrimSql, detoasted } from '../src/store/coordination-sql.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { workDocumentSql } from '../src/store/bounded-snapshot.js';
import { eventHistorySql, parseEventHistoryQuery, routineEventKinds } from '../src/events-history.js';
import { boundedHistoryRead, historyReadSlots } from '../src/server/history-reads.js';
import { coordinationViewHeader } from '../src/server/work-view.js';
import { listen } from './helpers/http-server.js';

// GY-3757: on an install with history, watching one item — `status GY-N`, the item page — took the
// line's database away. The per-item reads answer from indexes, at most four history reads run at
// once, and the loop's own snapshot read still answers while thirty readers watch one item.
const adminToken = `operator-${'a'.repeat(32)}`, coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const ITEMS = 2000, EVENTS = 50_000, ITEM_ROWS = 3000;
let store: Store, close: (() => Promise<void>) | undefined, url: string, id: string, key: string;

const coordinationLiveSql = `SELECT d.number, x.document, ${coordinationTrimSql('x.document', coordinationTail)} AS trimmed
  FROM (SELECT w.number, ${detoasted('w.document')} AS document FROM work_items w WHERE NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.settled) OFFSET 0) d
  CROSS JOIN ${coordinationRelevance(coordinationTail)} CROSS JOIN LATERAL (SELECT ${coordinationDocumentSql} AS document OFFSET 0) x`;
const coordinationSettledSql = 'SELECT number, summary AS document, trimmed FROM work_index WHERE settled';

const get = async (token: string, path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(60_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return { body, age: response.headers.get('age') };
};

before(async () => {
  store = await withDatabase('item-status-read-is-indexed-and-bounded'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }])));
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Watched item', why: 'Many readers watch it.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  ({ id, key } = await created.json() as { id: string; key: string });
  // A long-lived document carrying evidence, as status reads it.
  // Kept at 20 kB so the test process's own JSON work never stalls the server it shares an event loop with.
  await store.pool.query(`UPDATE work_items SET document = document || jsonb_build_object('padding', repeat('x', 20000)) WHERE id=$1`, [id]);
  const template = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document;
  delete template.padding;
  await store.pool.query(`INSERT INTO work_items(id, document) SELECT g.id, $1::jsonb || jsonb_build_object('id', g.id::text, 'key', 'GY-' || (g.n + 100))
    FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${ITEMS - 1}) n) g`, [template]);
  // The watched item's history: one whole snapshot and thousands of saves stored as deltas on it.
  const base = (await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT id, 'fixture', 'reconciled', jsonb_build_object('work', document) FROM work_items WHERE id=$1 RETURNING seq`, [id])).rows[0].seq;
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT $1, 'fixture', (ARRAY['reconciled','session','action.claimed'])[1 + d % 3],
    jsonb_build_object('delta', jsonb_build_object('base', $2::bigint, 'revision', 1, 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('title'), 'Watched item ' || d))), 'details', jsonb_build_object('reason', 'step ' || d))
    FROM generate_series(1, ${ITEM_ROWS}) d`, [id, base]);
  // The rest of the ledger across every other item, in one statement; unlogged, so seeding writes no WAL.
  await store.pool.query('ALTER TABLE events SET UNLOGGED');
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
    SELECT ids[1 + d % array_length(ids, 1)], 'fixture', (ARRAY['heartbeat','github.observed','reconciled'])[1 + d % 3], '{"details":{"n":1}}'::jsonb, now() - interval '30 days' + d * interval '1 millisecond'
    FROM (SELECT array_agg(id) AS ids FROM work_items WHERE id <> $1) i, generate_series(1, ${EVENTS - ITEM_ROWS - 1}) d`, [id]);
  await store.pool.query('ANALYZE');
  await planAsRows(store.pool, 'events', 2_000_000);
});

after(async () => { await close?.(); await store?.close(); });

test('integration:item-status-read-is-indexed-and-bounded — status GY-N and the item page answer from indexes with bounded rows and buffers planned as on two million events, with the rows of the plain query; four history reads at once, later ones get the last answer with its age, and the loop snapshot still answers', { timeout: 600_000 }, async () => {
  assert.ok(Number((await store.pool.query('SELECT count(*) FROM events')).rows[0].count) >= EVENTS);
  // The plans (with EXPLAIN (ANALYZE, BUFFERS)): the item by display key and by id through the work index's indexes; its history page through events_work.
  for (const value of [key, id]) {
    const docPlan = await explainAnalyzeBuffers(store.pool, workDocumentSql(value), [value]);
    assert.equal(docPlan.seqScans.length, 0, `status ${value} reads no table whole: ${docPlan.summary}`);
    assert.ok(docPlan.indexes.some(name => name === 'work_index_key' || name === 'work_index_pkey'), `status ${value} uses work_index: ${docPlan.summary}`);
    assert.ok(docPlan.rowsScanned() <= 4, `status ${value} scanned ${docPlan.rowsScanned()} rows: ${docPlan.summary}`);
    assert.ok(docPlan.buffers <= 50, `status ${value} touched ${docPlan.buffers} buffers: ${docPlan.summary}`);
  }
  const page = eventHistorySql(parseEventHistoryQuery(new URLSearchParams({ work: id, payload: 'details' })));
  const pagePlan = await explainAnalyzeBuffers(store.pool, page.text, page.values);
  assert.ok(!pagePlan.seqScans.includes('events'), `history page must not sequentially scan events: ${pagePlan.summary}`);
  assert.ok(pagePlan.indexes.some(name => name.startsWith('events_work')), `history page must use events_work*: ${pagePlan.summary}`);
  assert.ok(pagePlan.rowsScanned('events') <= 700, `history page scanned ${pagePlan.rowsScanned('events')} event rows: ${pagePlan.summary}`);
  assert.ok(pagePlan.buffers <= 5000, `history page touched ${pagePlan.buffers} buffers: ${pagePlan.summary}`);

  // Each read returns the expected payload.
  const status = await get(adminToken, `work/${key}`);
  assert.equal(status.body.key, key);
  const history = await get(adminToken, `events?work=${id}&payload=details`);
  assert.equal(history.body.length, 300);
  assert.equal(history.body[0].details.reason, `step ${ITEM_ROWS}`);
  const reference = await store.pool.query(`SELECT seq FROM events WHERE work_id=$1 AND kind <> ALL($2::text[]) ORDER BY seq DESC LIMIT 300`, [id, routineEventKinds]);
  assert.deepEqual(history.body.map((row: { seq: unknown }) => String(row.seq)), reference.rows.map(row => String(row.seq)));

  // Thirty readers watch the item at once — the history page whose plan is bounded above, and status. GY-3913: each reader runs that
  // bounded page, not the full-document one, whose cost under a loaded trial ran past the server's 5 s statement timeout; the history
  // queries in flight are counted on the client, whose interval holds the server's, so a short one is never missed.
  const inFlight = { now: 0, peak: 0 }, wrapped = new WeakSet<object>();
  const count = (client: pg.PoolClient) => {
    if (wrapped.has(client)) return; wrapped.add(client);
    const query = client.query.bind(client) as (...args: any[]) => any;
    (client as unknown as { query: (...args: any[]) => any }).query = (...args: any[]) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (typeof text !== 'string' || !text.startsWith('SELECT seq,work_id,actor,kind,created_at') || !text.includes('WHERE work_id=')) return query(...args);
      inFlight.peak = Math.max(inFlight.peak, ++inFlight.now);
      return Promise.resolve(query(...args)).finally(() => { inFlight.now--; });
    };
  };
  store.pool.on('acquire', count);
  try {
    const readers = Array.from({ length: 30 }, (_, n) => n % 3 === 0 ? get(adminToken, `work/${key}`) : get(adminToken, `events?work=${id}&payload=details`));
    await new Promise(resolve => setTimeout(resolve, 200));
    const loop = await get(coordinatorToken, 'work-snapshot', { [coordinationViewHeader]: 'coordination' });
    assert.ok(loop.body.work.some((item: { id: string }) => item.id === id));
    const livePlan = await explainAnalyzeBuffers(store.pool, coordinationLiveSql);
    const settledPlan = await explainAnalyzeBuffers(store.pool, coordinationSettledSql);
    for (const snapPlan of [livePlan, settledPlan]) {
      assert.ok(!snapPlan.seqScans.includes('events'), `coordination snapshot must not scan events: ${snapPlan.summary}`);
      assert.equal(snapPlan.rowsScanned('events'), 0, `coordination snapshot must read 0 event rows: ${snapPlan.summary}`);
    }
    assert.ok(livePlan.rowsScanned('work_items') <= ITEMS, `coordination live query scanned ${livePlan.rowsScanned('work_items')} work_items (limit ${ITEMS}): ${livePlan.summary}`);
    assert.ok(livePlan.buffers <= ITEMS * 5, `coordination live query touched ${livePlan.buffers} buffers: ${livePlan.summary}`);
    assert.ok(settledPlan.rowsScanned('work_index') <= ITEMS, `coordination settled query scanned ${settledPlan.rowsScanned('work_index')} work_index rows: ${settledPlan.summary}`);
    const answers = await Promise.all(readers);
    for (const answer of answers) assert.ok(Array.isArray(answer.body) ? answer.body.length === 300 : answer.body.key === key);
  } finally { store.pool.off('acquire', count); }
  assert.ok(inFlight.peak <= historyReadSlots, `at most ${historyReadSlots} history queries ran at once; saw ${inFlight.peak}`);
  assert.ok(inFlight.peak >= 1, 'the history queries were counted');

  // Every slot held: a read waits five seconds, then gets the last answer and its age.
  const held: (() => void)[] = [];
  const holders = Array.from({ length: historyReadSlots }, () => boundedHistoryRead(randomUUID(), () => new Promise<void>(resolve => held.push(resolve))));
  const started = Date.now();
  const late = await boundedHistoryRead(`/api/events?work=${id}&payload=details`, async () => { throw new Error('a waiting read runs no query'); }).catch(() => null);
  held.forEach(resolve => resolve()); await Promise.all(holders);
  assert.ok(late, 'a read with a last answer is answered from it');
  const waited = Date.now() - started;
  assert.ok(waited >= 4900 && waited < 7000, `it waited ${waited} ms`);
  assert.ok(late.ageMs !== null && late.ageMs >= 4900, `the answer carries its age: ${late.ageMs}`);
});
