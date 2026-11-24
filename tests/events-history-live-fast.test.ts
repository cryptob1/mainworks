import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import type { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { itemLedger, slowQueryAttention } from '../src/cli/master-status.js';
import { deliverySpeed, type MergedItem } from '../src/pipeline-speed.js';

// GY-3762: master status reads the whole ledger of the last 50 merged items, all at once, every few minutes. It
// asked for each event's resolved work document only to read its stage: on the live install that was 580 MB a run,
// one item 179 MB, and a read took 17.8 s. The seed has the live ledger's shape: a few items with long delta chains
// on large documents, many with short ones, and mostly routine rows.
const adminToken = `operator-${'a'.repeat(32)}`;
const stages = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'];
const EVERY = 20, ROUTINE = 200_000;
const shapes = [...Array.from({ length: 3 }, () => ({ rows: 800, kb: 180 })), ...Array.from({ length: 47 }, () => ({ rows: 150, kb: 15 }))];
const start = Date.parse('2026-11-20T00:00:00Z');
let store: Store, http: ReturnType<typeof server>, url: string;
let items: { id: string; key: string; rows: number }[] = [];

const api = (headers: Record<string, string> = {}) => async (path: string) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { ...headers, Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(120_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};
/** Row r (1-based) of an item: a full snapshot opens each run of EVERY rows with the next stage; the rest are deltas on it. */
const stageAt = (r: number) => stages[Math.floor((r - 1) / EVERY) % stages.length];
const minuteAt = (r: number) => new Date(start + r * 60_000).toISOString();

before(async () => {
  store = await withDatabase('events-history-live-fast'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Template', why: 'Its document seeds the ledger.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  const { id: templateId } = await created.json() as { id: string };
  await store.pool.query('ALTER TABLE events SET UNLOGGED');
  // Each item: a `ready` full snapshot, then runs of EVERY rows, a full snapshot opening each with the next stage and
  // deltas on it after, as appendSave writes them; its document carries kb kilobytes of history that compresses like the live one.
  for (const [index, shape] of shapes.entries()) {
    const id = randomUUID(), key = `GY-${index + 100}`;
    items.push({ id, key, rows: shape.rows });
    await store.pool.query(`INSERT INTO work_items(id, document) SELECT $1::uuid, document || jsonb_build_object('id', $1::text, 'key', $2::text) FROM work_items WHERE id=$3`, [id, key, templateId]);
    await store.pool.query(`DO $$ DECLARE doc jsonb; base bigint; r int; BEGIN
      SELECT document || jsonb_build_object('log', (SELECT jsonb_agg(md5(g::text) || ' ' || repeat(md5((g % 97)::text), 2)) FROM generate_series(1, ${shape.kb * 10}) g)) INTO doc FROM work_items WHERE id='${id}';
      FOR r IN 1..${shape.rows} LOOP
        IF (r - 1) % ${EVERY} = 0 THEN
          INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES ('${id}', 'fixture', CASE WHEN r = 1 THEN 'ready' ELSE 'reconciled' END,
            jsonb_build_object('work', jsonb_set(doc, '{stage}', to_jsonb((ARRAY[${stages.map(stage => `'${stage}'`).join(',')}])[1 + ((r - 1) / ${EVERY}) % ${stages.length}]))),
            '${minuteAt(0)}'::timestamptz + make_interval(mins => r)) RETURNING seq INTO base;
        ELSE
          INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES ('${id}', 'fixture', (ARRAY['session','action.claimed','reconciled'])[1 + r % 3],
            jsonb_build_object('delta', jsonb_build_object('base', base, 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('revision'), to_jsonb(r::text)))), 'details', jsonb_build_object('step', r)),
            '${minuteAt(0)}'::timestamptz + make_interval(mins => r));
        END IF;
      END LOOP; END $$`);
  }
  await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload) SELECT ids[1 + d % array_length(ids, 1)], 'fixture', (ARRAY['heartbeat','github.observed'])[1 + d % 2], '{"details":{"n":1}}'::jsonb
    FROM (SELECT array_agg(id) AS ids FROM work_items) i, generate_series(1, ${ROUTINE}) d`);
  await store.pool.query('ANALYZE events');
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await store?.close();
});

test('integration:events-history-live-fast — master status\'s ledger reads of 50 merged items answer in under 3 s each on a live-shaped ledger with unchanged results, and a slow query names its caller', { timeout: 600_000 }, async () => {
  const read = api({ 'X-Mainworks-Command': 'master status' });
  // The read master status makes: every merged item's ledger, all at once; each answers in under 3 s.
  const timed = await Promise.all(items.map(async item => {
    const started = performance.now();
    const events = await itemLedger(read, item.id);
    return { item, events, ms: performance.now() - started };
  }));
  const slowest = timed.reduce((max, entry) => entry.ms > max.ms ? entry : max);
  assert.ok(slowest.ms < 3000, `${slowest.item.key}'s ledger read took ${Math.round(slowest.ms)} ms`);
  assert.equal((await read('slowest-query?name=SELECT%20seq%2Cwork_id%2Cactor%2Ckind%2Ccreated_at')).slowest, null);

  // The results are unchanged: every row, oldest first, with the stage its snapshot holds, and the same delivery speed.
  for (const { item, events } of timed) {
    assert.ok(events, `${item.key}'s ledger was read`);
    assert.deepEqual(events.map(event => event.created_at), Array.from({ length: item.rows }, (_, r) => minuteAt(r + 1)));
    const stageOf = (event: (typeof events)[number]) => (event as { stage?: string }).stage ?? (event as { payload?: { work?: { stage?: string } } }).payload?.work?.stage;
    assert.deepEqual(events.map(stageOf), Array.from({ length: item.rows }, (_, r) => stageAt(r + 1)), item.key);
  }
  const merged: MergedItem[] = timed.map(({ item, events }) => ({ key: item.key, mergedAt: minuteAt(item.rows + 10), attempts: 1, events }));
  const speed = deliverySpeed(merged, [], start);
  assert.deepEqual(speed.unmeasured, []);
  assert.deepEqual(speed.readyToMerge, { median: 159, p90: 159, samples: 50 });
  // The short items pass through ready twice: rows 1-20 and 121-140.
  assert.deepEqual(speed.stages.ready, { median: 2 * EVERY, p90: 2 * EVERY, samples: 50 });

  // A slow statement names who asked: the route, the principal and the command. The events table is held for 3.2 s.
  const lock = await store.pool.connect();
  try {
    await lock.query('BEGIN'); await lock.query('LOCK TABLE events IN ACCESS EXCLUSIVE MODE');
    const held = read(`events?work=${items[0].id}&order=asc&limit=999&view=page&payload=stage`);
    await new Promise(resolve => setTimeout(resolve, 3200));
    await lock.query('COMMIT');
    await held;
  } finally { lock.release(); }
  const named = (await read('slowest-query?name=SELECT%20seq%2Cwork_id%2Cactor%2Ckind%2Ccreated_at')).slowest;
  assert.ok(named, 'the held read is reported');
  assert.equal(named.caller, 'master status via GET /api/events as operator');
  assert.match(slowQueryAttention(named, Date.now())[0].text, /, asked by master status via GET \/api\/events as operator: SELECT seq,work_id/);
});
