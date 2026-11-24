import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { parseEventHistoryQuery, readEventHistory } from '../src/events-history.js';

// GY-3761: the history page resolved every candidate row's payload (graphyard_event_work) before
// it applied its limit, so on a real ledger it ran for minutes and loaded the database while
// failing. It now selects the page's seq values first and resolves payloads for those rows only.
const adminToken = `operator-${'a'.repeat(32)}`;
const ITEMS = 2000, EVENTS = 2_000_000, KEPT = 5000, OTHERS = 20_000, ITEM_ROUTINE = 50_000;
let store: Store, counted: pg.Pool, http: ReturnType<typeof server>, url: string, id: string;

const get = async (path: string) => {
  const started = performance.now();
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(120_000) });
  const body = await response.json();
  return { status: response.status, body, ms: performance.now() - started };
};

before(async () => {
  const connection = await databaseUrl('event-history-pages');
  store = new Store(connection); await store.init();
  // One connection that counts plpgsql calls, so a read's graphyard_event_work calls can be read back.
  counted = new pg.Pool({ connectionString: connection, max: 1, options: '-c track_functions=pl' }); counted.on('error', () => {});
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Watched item', why: 'Its history is long.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  ({ id } = await created.json() as { id: string });
  const template = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document;
  await store.pool.query(`INSERT INTO work_items(id, document) SELECT g.id, $1::jsonb || jsonb_build_object('id', g.id::text, 'key', 'GY-' || (g.n + 100))
    FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${ITEMS - 1}) n) g`, [template]);
  await store.pool.query('ALTER TABLE events SET UNLOGGED');
  const base = (await store.pool.query(`SELECT seq FROM events WHERE work_id=$1 AND payload ? 'work' ORDER BY seq DESC LIMIT 1`, [id])).rows[0].seq;
  const delta = (d: string) => `jsonb_build_object('details', jsonb_build_object('step', ${d}), 'delta', jsonb_build_object('base', ${base}, 'revision', ${d}, 'updatedAt', now(), 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('title'), 'step ' || ${d}))))`;
  const others = `(SELECT array_agg(id) AS ids FROM work_items WHERE id <> '${id}') i`;
  // Every row worth reading is a delta the read must resolve; then millions of routine rows.
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT $1, 'fixture', (ARRAY['reconciled','session','action.claimed'])[1 + d % 3], ${delta('d')}
    FROM generate_series(1, ${KEPT}) d`, [id]);
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT ids[1 + d % array_length(ids, 1)], 'fixture', (ARRAY['reconciled','session','action.claimed'])[1 + d % 3], ${delta('d')}
    FROM ${others}, generate_series(1, ${OTHERS}) d`);
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT $1, 'fixture', (ARRAY['heartbeat','github.observed'])[1 + d % 2], ${delta('d')}
    FROM generate_series(1, ${ITEM_ROUTINE}) d`, [id]);
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT ids[1 + d % array_length(ids, 1)], 'fixture', (ARRAY['heartbeat','github.observed'])[1 + d % 2], '{"details":{"n":1}}'::jsonb
    FROM ${others}, generate_series(1, ${EVENTS - ITEM_ROUTINE - OTHERS - KEPT}) d`);
  await store.pool.query('ANALYZE events');
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await counted?.end(); await store?.close();
});

/** graphyard_event_work calls one read makes, from the counting connection's own function statistics. */
async function calls(params: Record<string, string>) {
  const total = async () => {
    await counted.query('SELECT pg_stat_force_next_flush()');
    await counted.query('SELECT pg_stat_clear_snapshot()');
    return Number((await counted.query(`SELECT coalesce(sum(calls), 0) AS calls FROM pg_stat_user_functions WHERE funcname='graphyard_event_work'`)).rows[0].calls);
  };
  const before = await total();
  const query = parseEventHistoryQuery(new URLSearchParams(params));
  const page = await readEventHistory(counted, query);
  return { calls: await total() - before, page, limit: query.limit };
}

test('integration:event-history-pages-before-resolving — a history page resolves payloads only for the rows it returns, answers in under a second on two million events, and a read past 5 s names the filter to narrow', { timeout: 900_000 }, async () => {
  assert.ok(Number((await store.pool.query('SELECT count(*) FROM events')).rows[0].count) >= EVENTS);

  // At most limit+1 resolutions per read, whatever the filters make the planner do.
  for (const params of <Record<string, string>[]>[{ payload: 'full' }, { work: id, payload: 'full' }, { work: id, payload: 'full', kind: 'reconciled' },
    { work: id, payload: 'full', routine: 'include', limit: '1000' }, { payload: 'full', kind: 'session', since: new Date(Date.now() - 86_400_000).toISOString() },
    { work: id, payload: 'full', order: 'asc' }]) {
    const read = await calls(params);
    assert.equal(read.page.events.length, read.limit, JSON.stringify(params));
    assert.ok(read.calls <= read.limit + 1, `${JSON.stringify(params)}: graphyard_event_work ran ${read.calls} times for a page of ${read.limit}`);
    assert.ok(read.page.events.every(row => !('work' in params) || row.payload?.work), JSON.stringify(params));
  }

  // The default page and one item's page each answer in under a second.
  await get('events'); await get(`events?work=${id}`);
  const all = await get('events?view=history');
  assert.equal(all.status, 200, JSON.stringify(all.body).slice(0, 300));
  assert.ok(all.ms < 1000, `the default events page took ${Math.round(all.ms)} ms`);
  const item = await get(`events?work=${id}&view=history`);
  assert.equal(item.status, 200, JSON.stringify(item.body).slice(0, 300));
  assert.ok(item.ms < 1000, `one item's events page took ${Math.round(item.ms)} ms`);
  assert.equal(item.body.events[0].payload.details.step, KEPT);
  assert.equal(item.body.events[0].payload.work.title, `step ${KEPT}`);

  // A read that runs past the route's 5 s statement timeout answers a plain error naming the filter to narrow.
  const holder = await store.pool.connect();
  try {
    await holder.query('BEGIN'); await holder.query('LOCK TABLE events IN ACCESS EXCLUSIVE MODE');
    const slow = await get('events');
    assert.ok(slow.ms < 9000, `the timed-out read took ${Math.round(slow.ms)} ms`);
    assert.equal(slow.status, 422, JSON.stringify(slow.body));
    assert.match(JSON.stringify(slow.body), /5 s.*work/);
  } finally { await holder.query('ROLLBACK'); holder.release(); }
});
