import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import type { Store } from '../src/store.js';
import type { Work } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { itemLedger, masterStatusReport } from '../src/cli/master-status.js';
import { eventHistorySql, parseEventHistoryQuery } from '../src/events-history.js';
import { explainAnalyzeBuffers } from './helpers/query-plan.js';
import { appendSave, eventStageSql } from '../src/store/snapshot-delta.js';
import { listen } from './helpers/http-server.js';

// GY-3766: the events history's stage mode resolved every delta row's whole document just to read its stage. A delta
// row now carries the stage beside its delta, so the read takes it from the row and resolves only older rows without it.
const adminToken = `operator-${'a'.repeat(32)}`;
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const stages = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'];
const ITEMS = 50, ROWS = 800, KB = 180, EVERY = 100;
const start = Date.parse('2026-11-20T00:00:00Z');
let store: Store, close: (() => Promise<void>) | undefined, url: string, templateId: string;
const items: { id: string; key: string; rows: number; legacy: boolean }[] = [];
const stageAt = (r: number) => stages[Math.floor((r - 1) / EVERY) % stages.length];
const minuteAt = (r: number) => new Date(start + r * 60_000).toISOString();
const api = async (path: string) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${adminToken}`, 'X-Mainworks-Command': 'master status' }, signal: AbortSignal.timeout(120_000) });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
};

before(async () => {
  store = await withDatabase('event-stage-stored'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }])));
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Template', why: 'Its document seeds the ledger.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  templateId = (await created.json() as { id: string }).id;
  await store.pool.query('ALTER TABLE events SET UNLOGGED');
  // Each item: 800 rows on a 180 KB document, a full snapshot opening each run of EVERY rows with the next stage and
  // deltas on it after, carrying the stage as appendSave now writes. One more item has 60 rows of the older shape without it.
  for (let index = 0; index <= ITEMS; index++) {
    const id = randomUUID(), key = `GY-${index + 100}`, legacy = index === ITEMS, rows = legacy ? 60 : ROWS;
    items.push({ id, key, rows, legacy });
    await store.pool.query(`INSERT INTO work_items(id, document) SELECT $1::uuid, document || jsonb_build_object('id', $1::text, 'key', $2::text) FROM work_items WHERE id=$3`, [id, key, templateId]);
    await store.pool.query(`DO $$ DECLARE doc jsonb; base bigint; st text; r int; BEGIN
      SELECT document || jsonb_build_object('log', (SELECT jsonb_agg(md5(g::text) || ' ' || repeat(md5((g % 97)::text), 2)) FROM generate_series(1, ${KB * 10}) g)) INTO doc FROM work_items WHERE id='${id}';
      FOR r IN 1..${rows} LOOP
        st := (ARRAY[${stages.map(stage => `'${stage}'`).join(',')}])[1 + ((r - 1) / ${EVERY}) % ${stages.length}];
        IF (r - 1) % ${EVERY} = 0 THEN
          INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES ('${id}', 'fixture', CASE WHEN r = 1 THEN 'ready' ELSE 'reconciled' END,
            jsonb_build_object('work', jsonb_set(doc, '{stage}', to_jsonb(st))), '${minuteAt(0)}'::timestamptz + make_interval(mins => r)) RETURNING seq INTO base;
        ELSE
          INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES ('${id}', 'fixture', (ARRAY['session','action.claimed','reconciled'])[1 + r % 3],
            jsonb_build_object('delta', jsonb_build_object('base', base, 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('revision'), to_jsonb(r::text)))), 'details', jsonb_build_object('step', r))
              || ${legacy ? `'{}'::jsonb` : `jsonb_build_object('stage', st)`},
            '${minuteAt(0)}'::timestamptz + make_interval(mins => r));
        END IF;
      END LOOP; END $$`);
  }
  await store.pool.query('ANALYZE events');
});

after(async () => { await close?.(); await store?.close(); });

test('integration:event-stage-stored — a delta row written by appendSave carries the stage, and the stage read of 50 items with 800-row delta chains on 180 KB documents answers in under 1 s with unchanged stages', { timeout: 600_000 }, async () => {
  // appendSave writes the item's stage beside its delta.
  const id = randomUUID();
  await store.pool.query(`INSERT INTO work_items(id, document) SELECT $1::uuid, document || jsonb_build_object('id', $1::text, 'key', 'GY-99') FROM work_items WHERE id=$2`, [id, templateId]);
  const work = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
  const client = await store.pool.connect();
  try {
    await appendSave(client, { ...work, stage: 'build' }, 'fixture', 'transition');
    await appendSave(client, { ...work, stage: 'build', revision: work.revision + 1 }, 'fixture', 'updated', { n: 1 });
  } finally { client.release(); }
  const saved = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 ORDER BY seq`, [id])).rows.map(row => row.payload);
  assert.equal(saved[0].work.stage, 'build');
  assert.ok(saved[1].delta, 'the second save is a delta');
  assert.equal(saved[1].stage, 'build');
  assert.deepEqual(saved[1].details, { n: 1 });
  const page = await api(`events?work=${id}&order=asc&limit=10&view=page&payload=stage`);
  assert.deepEqual(page.events.map((event: { stage: string }) => event.stage), ['build', 'build']);
  // The full payload of a delta row is still the resolved document's shape.
  const full = await api(`events?work=${id}&order=asc&limit=10&view=page`);
  assert.deepEqual(Object.keys(full.events[1].payload).sort(), ['details', 'work']);
  assert.equal(full.events[1].payload.work.revision, work.revision + 1);

  // The read master status makes, every item at once: each answers in under 1 s with the same stages as before.
  const timed = await Promise.all(items.filter(item => !item.legacy).map(async item => {
    const started = performance.now();
    const events = await itemLedger(api, item.id);
    return { item, events, ms: performance.now() - started };
  }));
  const slowest = timed.reduce((max, entry) => entry.ms > max.ms ? entry : max);
  assert.ok(slowest.ms < 1000, `${slowest.item.key}'s stage read took ${Math.round(slowest.ms)} ms`);
  // The older item's delta rows carry no stage and are resolved from their snapshot.
  const legacy = items.find(item => item.legacy)!;
  timed.push({ item: legacy, events: await itemLedger(api, legacy.id), ms: 0 });
  for (const { item, events } of timed) {
    assert.ok(events, `${item.key}'s ledger was read`);
    assert.deepEqual(events.map(event => event.created_at), Array.from({ length: item.rows }, (_, r) => minuteAt(r + 1)), item.key);
    assert.deepEqual(events.map(event => (event as { stage?: string }).stage), Array.from({ length: item.rows }, (_, r) => stageAt(r + 1)), item.key);
  }
});

test('e2e:event-stage-stored — after an item changes stage on a running test install, master status shows its delivery speed and no events query over 3 s', { timeout: 600_000 }, async () => {
  // Reading stored stages must not detoast the 180 KB whole snapshots.
  const stored = await explainAnalyzeBuffers(store.pool,
    `SELECT stage FROM events WHERE work_id=$1 ORDER BY seq`, [items[0].id]);
  const projected = await explainAnalyzeBuffers(store.pool,
    `SELECT ${eventStageSql()} FROM events WHERE work_id=$1 ORDER BY seq`, [items[0].id]);
  assert.equal(projected.rows, ROWS);
  assert.ok(projected.buffers <= stored.buffers + 10,
    `stage projection opened snapshot payloads: ${projected.summary}; column: ${stored.summary}`);
  const query = eventHistorySql(parseEventHistoryQuery(new URLSearchParams({ work: items[0].id, order: 'asc', limit: '1000', view: 'page', payload: 'stage' })));
  const pagePlan = await explainAnalyzeBuffers(store.pool, query.text, query.values);
  assert.equal(pagePlan.rows, ROWS);
  assert.ok(pagePlan.buffers < ROWS, `stage page must not probe each row again: ${pagePlan.summary}`);
  // The seeded items merged; one more changes stage through appendSave and merges, so master status reads its stored stages.
  const doneAt = (r: number) => minuteAt(r);
  await store.pool.query(`UPDATE work_items SET document = document || jsonb_build_object('stage', 'done', 'delivery', jsonb_build_object('mergedAt', $2::text, 'mergeSha', repeat('a', 40), 'authorizationRevision', 1)) WHERE id = ANY($1::uuid[])`,
    [items.filter(item => !item.legacy).map(item => item.id), doneAt(ROWS + 10)]);
  const id = randomUUID();
  await store.pool.query(`INSERT INTO work_items(id, document) SELECT $1::uuid, document || jsonb_build_object('id', $1::text, 'key', 'GY-98') FROM work_items WHERE id=$2`, [id, templateId]);
  const work = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
  const client = await store.pool.connect();
  try {
    await appendSave(client, { ...work, stage: 'ready' }, 'fixture', 'ready');
    await appendSave(client, { ...work, stage: 'ready', revision: work.revision + 1 }, 'fixture', 'updated');
    await appendSave(client, { ...work, stage: 'merge', revision: work.revision + 2 }, 'fixture', 'transition');
  } finally { client.release(); }
  const merged = { ...work, stage: 'done', revision: work.revision + 3, delivery: { mergedAt: new Date().toISOString(), mergeSha: 'b'.repeat(40), authorizationRevision: 1 } } as Work;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [id, merged]);

  const directory = await temporaryDirectory('event-stage-stored');
  const config = masterConfigSchema.parse({ version: 1, url, repository: 'owner/project', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const root = await temporaryDirectory('event-stage-stored-root');
  execFileSync('git', ['init', '-q', root]);
  const masterApi = async (path: string) => {
    const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${coordinatorToken}`, 'X-Mainworks-Command': 'master status' }, signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(text), { status: response.status });
    return JSON.parse(text);
  };
  const status = await masterStatusReport(root, config, masterApi, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
  // Master status reads the newest 50 merged items: the one just merged and 49 seeded ones, every one measured.
  assert.deepEqual(status.deliverySpeed.unmeasured, []);
  assert.equal(status.deliverySpeed.readyToMerge?.samples, 50);
  assert.equal((await masterApi('slowest-query?name=SELECT%20seq%2Cwork_id%2Cactor%2Ckind%2Ccreated_at')).slowest, null);
  // GY-3809: the stage is written at insert only; there is no backfill to run or report.
  assert.ok(!('stageBackfill' in status));
  const backfill = await fetch(`${url}/api/events/backfill-stage`, { method: 'POST', headers: { Authorization: `Bearer ${coordinatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}' });
  assert.equal(backfill.status, 404);
});
