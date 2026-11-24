import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import type { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { flowAttemptsSql, flowLedgerSql, readFlow } from '../src/server/flow.js';

// GY-3763: the flow numbers were one of the heaviest reads on the install they measure. They are now
// computed by one job at most once a minute over the last 7 days' rows, read by a range on insertion
// time, and every reader is served the stored result with its age.
const adminToken = `operator-${'f'.repeat(32)}`;
const ITEMS = 2000, EVENTS = 2_000_000, WINDOW = 50_000;
const flowKinds = ['rework', 'merge.intent', 'merge.trial', 'merge.refused', 'merge.serve-revert'];
let store: Store, http: ReturnType<typeof server>, url: string;

before(async () => {
  store = await withDatabase('flow-numbers-computed-once-a-minute'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Template', why: 'Flow is measured.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  const { id } = await created.json() as { id: string };
  const template = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document;
  await store.pool.query(`INSERT INTO work_items(id, document) SELECT g.id, $1::jsonb || jsonb_build_object('id', g.id::text, 'key', 'GY-' || (g.n + 100))
    FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${ITEMS - 1}) n) g`, [template]);
  await store.pool.query('ALTER TABLE events SET UNLOGGED');
  const ids = `(SELECT array_agg(id) AS ids FROM work_items) i`;
  // Every tenth row a whole document, the rest the flow kinds and routine rows: 1,950,000 of them older than the window, 50,000 inside it.
  const row = (count: number, from: string, spanSeconds: number) => `INSERT INTO events(work_id, actor, kind, payload, created_at)
    SELECT ids[1 + d % array_length(ids, 1)], 'fixture', CASE WHEN d % 10 = 0 THEN 'saved' ELSE (ARRAY['heartbeat','merge.trial','rework','merge.intent','github.observed'])[1 + d % 5] END,
      CASE WHEN d % 10 = 0 THEN jsonb_build_object('work', jsonb_build_object('stage', (ARRAY['build','review','test','merge','done'])[1 + d / 10 % 5], 'pad', repeat(md5(d::text), 20)))
        ELSE jsonb_build_object('head', md5(d::text), 'durationMs', 600000, 'details', jsonb_build_object('reason', 'reviewer requested changes')) END,
      ${from} + make_interval(secs => d * ${spanSeconds}::float8 / ${count})
    FROM ${ids}, generate_series(1, ${count}) d`;
  await store.pool.query(row(EVENTS - WINDOW, `now() - interval '400 days'`, 390 * 86_400));
  await store.pool.query(row(WINDOW, `now() - interval '7 days' + interval '1 minute'`, 7 * 86_400 - 120));
  await store.pool.query('ANALYZE events');
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await store?.close();
});

const get = async (path: string) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(60_000) });
  const body = await response.json() as any;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

test('integration:flow-numbers-computed-once-a-minute — one job reads the 7-day window by a created_at range in under 2 s on two million events, and concurrent readers share its result with its age', { timeout: 900_000 }, async () => {
  assert.ok(Number((await store.pool.query('SELECT count(*) FROM events')).rows[0].count) >= EVENTS);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const inWindow = Number((await store.pool.query('SELECT count(*) FROM events WHERE created_at > $1', [since])).rows[0].count);
  assert.ok(inWindow >= WINDOW && inWindow < WINDOW + 10, `${inWindow} events in the window`);

  // The plans: both halves of the ledger read are index range scans on created_at; the attempts read takes no events (GY-3764).
  const plan = async (text: string, values: unknown[]) => (await store.pool.query(`EXPLAIN ${text}`, values)).rows.map(row => row['QUERY PLAN']).join('\n');
  const ledgerPlan = await plan(flowLedgerSql, [since, flowKinds]);
  assert.doesNotMatch(ledgerPlan, /Seq Scan on events/, ledgerPlan);
  assert.match(ledgerPlan, /Index Scan using events_work_flow on events[^\n]*\n\s*Index Cond: \(created_at > /, ledgerPlan);
  assert.match(ledgerPlan, /Index Scan using events_(kind_)?created on events[^\n]*\n\s*Index Cond: [^\n]*created_at > /, ledgerPlan);
  const attemptsPlan = await plan(flowAttemptsSql, [since]);
  assert.doesNotMatch(attemptsPlan, /on events/, attemptsPlan);

  // The computation, warmed once, finishes in under 2 seconds.
  const work = await store.fleet();
  await readFlow(store.pool, work, Date.now());
  const started = performance.now();
  const flow = await readFlow(store.pool, work, Date.now());
  const ms = performance.now() - started;
  assert.ok(ms < 2000, `the flow computation took ${Math.round(ms)} ms`);
  assert.ok(flow['7d'].trials > 0);

  // Readers: ten at once start one computation; the next read within the minute starts none and is served the same result with its age.
  const original = store.pool.query.bind(store.pool);
  let computations = 0;
  (store.pool as any).query = (...args: any[]) => { if (args[0] === flowLedgerSql) computations++; return (original as any)(...args); };
  try {
    const answers = await Promise.all(Array.from({ length: 10 }, () => get('flow')));
    assert.equal(computations, 1);
    assert.equal(new Set(answers.map(answer => answer.asOf)).size, 1);
    assert.equal(answers[0]['7d'].trials, flow['7d'].trials);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const later = await get('flow');
    assert.equal(computations, 1);
    assert.equal(later.asOf, answers[0].asOf);
    assert.ok(later.ageSeconds >= 1, `age ${later.ageSeconds}`);
  } finally { (store.pool as any).query = original; }
});
