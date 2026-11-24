import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { explainAnalyzeBuffers } from './helpers/query-plan.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { namedPool } from '../src/store/report-pool.js';
import { eventWorkSql } from '../src/store/snapshot-delta.js';
import { eventStageBackfill } from '../src/daemon/event-stage-backfill.js';

// The batch UPDATE statement run by backfillEventStage (src/store/snapshot-delta.ts).
const backfillEventStageSql = `WITH batch AS (SELECT seq, work_id, payload->'delta' AS d FROM events WHERE payload ? 'delta' AND NOT payload ? 'stage' ORDER BY seq LIMIT $1),
  bases AS MATERIALIZED (SELECT b.seq, b.work_id, b.payload->'work'->>'stage' AS stage FROM events b
    WHERE b.seq IN (SELECT DISTINCT (d->>'base')::bigint FROM batch) AND b.payload ? 'work')
  UPDATE events e SET payload = e.payload || jsonb_build_object('stage', CASE WHEN bases.seq IS NULL THEN NULL
      WHEN edit.op IS NULL THEN bases.stage WHEN jsonb_array_length(edit.op) = 1 THEN NULL ELSE edit.op->1 #>> '{}' END)
  FROM batch LEFT JOIN bases ON bases.seq = (batch.d->>'base')::bigint AND bases.work_id = batch.work_id
    LEFT JOIN LATERAL (SELECT o.value AS op FROM jsonb_array_elements(CASE WHEN jsonb_typeof(batch.d->'ops') = 'array' THEN batch.d->'ops' ELSE '[]' END) WITH ORDINALITY o(value, n)
      WHERE o.value->0 = '["stage"]' ORDER BY o.n DESC LIMIT 1) edit ON true
  WHERE e.seq = batch.seq RETURNING e.seq`;

// GY-3769: GY-3768's 1,000-row batches of long-chain rows ran past the statement timeout and stored nothing, again
// each cycle. The loop now starts at 50 rows and sizes each batch from the last one's time to take about 1 s (GY-3771).
// The seed's statement timeout is 5 s; a 1,000-row batch of these rows takes > 10 s.
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const ITEMS = 2, ROWS = 800, KB = 180, EVERY = 100, OPS = 128, TIMEOUT_MS = 5_000;
let store: Store, plain: pg.Pool, http: ReturnType<typeof server>, url: string;
const call = async (path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${coordinatorToken}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
const lacking = async () => Number((await store.pool.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND NOT payload ? 'stage'`)).rows[0].count);

before(async () => {
  const database = await databaseUrl('backfill-stage-small');
  store = new Store(database); await store.init();
  // GY-3771: seed before applying the 5 s statement timeout and namedPool so fixture setup never times out under load or enters slow-queries.
  await store.pool.query('ALTER TABLE events SET UNLOGGED');
  // Each item: 800 rows of the older shape on a 180 KB document, a full snapshot opening each run of EVERY rows with
  // its own stage and deltas of OPS edits without a stored stage after it.
  for (let index = 0; index < ITEMS; index++) {
    const id = randomUUID();
    await store.pool.query(`INSERT INTO work_items(id, document) VALUES ($1::uuid, jsonb_build_object('id', $1::text, 'key', $2::text, 'stage', 'ready', 'revision', 1))`, [id, `GY-${index + 100}`]);
    await store.pool.query(`DO $$ DECLARE doc jsonb; base bigint; r int; BEGIN
      SELECT document || jsonb_build_object('log', (SELECT jsonb_agg(md5(g::text) || ' ' || repeat(md5((g % 97)::text), 2)) FROM generate_series(1, ${KB * 10}) g)) INTO doc FROM work_items WHERE id='${id}';
      FOR r IN 1..${ROWS} LOOP
        IF (r - 1) % ${EVERY} = 0 THEN
          INSERT INTO events(work_id, actor, kind, payload) VALUES ('${id}', 'fixture', 'reconciled', jsonb_build_object('work', jsonb_set(doc, '{stage}', to_jsonb('stage-' || r)))) RETURNING seq INTO base;
        ELSE
          INSERT INTO events(work_id, actor, kind, payload) VALUES ('${id}', 'fixture', 'session',
            jsonb_build_object('delta', jsonb_build_object('base', base, 'ops', (SELECT jsonb_agg(jsonb_build_array(jsonb_build_array('field' || o), to_jsonb(r))) FROM generate_series(1, ${OPS}) o))));
        END IF;
      END LOOP; END $$`);
  }
  await store.pool.query('ANALYZE events');
  await store.pool.end();
  store.pool = namedPool(database, 12, 10_000, TIMEOUT_MS);
  // The test's own probe and check run beside the server's pool, so master status never names them.
  plain = new pg.Pool({ connectionString: database, statement_timeout: TIMEOUT_MS }).on('error', () => {});
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await plain?.end(); await store?.close();
});

test('integration:backfill-stage-small-batches — on 800-row chains of 180 KB documents every backfill batch finishes in under 5 s and stores at least one row, until every delta row carries the stage graphyard_event_work gives', { timeout: 600_000 }, async () => {
  const before = await lacking();
  assert.equal(before, ITEMS * (ROWS - ROWS / EVERY));
  // The seed is long enough: GY-3768's 1,000-row batch, which rebuilt each row's document, runs past the timeout and
  // stores nothing (GY-3772 no longer rebuilds documents, so its statement is kept here).
  await assert.rejects(plain.query(`SET LOCAL graphyard.stage_backfill = 'on'; UPDATE events e SET payload = e.payload || jsonb_build_object('stage', ${eventWorkSql('e')}->>'stage')
    FROM (SELECT seq FROM events WHERE payload ? 'delta' AND NOT payload ? 'stage' ORDER BY seq LIMIT 1000) b WHERE e.seq = b.seq`), /statement timeout/);
  assert.equal(await lacking(), before);

  // Plan and buffer bound on a 50-row backfill batch (rolled back so the loop below still backfills every row):
  // uses events_stageless_delta without scanning events whole, reads only the batch + its bases, and never rebuilds documents.
  const probeClient = await plain.connect();
  try {
    await probeClient.query('BEGIN');
    await probeClient.query("SET LOCAL graphyard.stage_backfill = 'on'");
    const batchPlan = await explainAnalyzeBuffers(probeClient, backfillEventStageSql, [50]);
    await probeClient.query('ROLLBACK');
    assert.ok(!batchPlan.seqScans.includes('events'), `backfill batch must not sequentially scan events: ${batchPlan.summary}`);
    assert.ok(batchPlan.indexes.includes('events_stageless_delta'), `backfill batch must use events_stageless_delta: ${batchPlan.summary}`);
    assert.ok(batchPlan.rowsScanned('events') <= 50 * 3, `backfill batch scanned ${batchPlan.rowsScanned('events')} event rows (limit 150): ${batchPlan.summary}`);
    assert.ok(batchPlan.buffers <= 50 * 60, `backfill batch touched ${batchPlan.buffers} buffers (limit 3000): ${batchPlan.summary}`);
  } finally { probeClient.release(); }

  const lines: string[] = [], batches: { limit: number; filled: number }[] = [];
  const cycle = eventStageBackfill(async limit => {
    const answer = await call('events/backfill-stage', { limit });
    batches.push({ limit, filled: answer.filled });
    return answer;
  });
  let left = before;
  while (!lines.some(line => /backfill is done/.test(line))) {
    assert.ok(batches.length < 200, `the backfill had not finished after ${batches.length} cycles`);
    await cycle(line => lines.push(line));
    const batch = batches.at(-1)!, now = await lacking();
    if (now) assert.ok(now < left, `cycle ${batches.length} stored nothing`);
    assert.equal(left - now, batch.filled);
    if (batch.filled) assert.match(lines.at(-1)!, new RegExp(`stored ${batch.filled} rows`));
    left = now;
  }
  assert.equal(left, 0);
  assert.equal(batches[0].limit, 50);
  const differing = await plain.query(`SET statement_timeout = 0; SELECT count(*) FROM events WHERE payload ? 'delta' AND payload->>'stage' IS DISTINCT FROM graphyard_event_work(work_id, payload)->>'stage'`);
  assert.equal(Number((differing as unknown as pg.QueryResult[])[1].rows[0].count), 0);
});

test('e2e:backfill-stage-small-batches — after the backfill on a running test install with long delta chains, master status names no backfill statement over 5 s', async () => {
  const slowest = (await call('slowest-query?name=WITH%20batch%20AS%20(SELECT%20seq%2C%20work_id')).slowest;
  assert.ok(!slowest || slowest.ms < TIMEOUT_MS, `master status names ${JSON.stringify(slowest)}`);
});
