import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { itemLedger, masterStatusReport } from '../src/cli/master-status.js';
import { eventStageBackfill } from '../src/daemon/event-stage-backfill.js';

// GY-3768: delta rows written before GY-3766 carry no stage, so the stage read still rebuilt their documents. The loop
// fills the stage on them in batches of at most 1,000 until none lack it.
const adminToken = `operator-${'a'.repeat(32)}`;
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const stages = ['ready', 'build', 'review', 'test', 'acceptance', 'merge'];
const ITEMS = 50, ROWS = 800, KB = 180, EVERY = 100;
const start = Date.parse('2026-11-20T00:00:00Z');
let store: Store, http: ReturnType<typeof server>, url: string, templateId: string;
const items: { id: string; key: string }[] = [];
const stageAt = (r: number) => stages[Math.floor((r - 1) / EVERY) % stages.length];
const minuteAt = (r: number) => new Date(start + r * 60_000).toISOString();
const call = async (path: string, token: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${token}`, 'X-Mainworks-Command': 'master status', ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${path}: ${text.slice(0, 300)}`), { status: response.status });
  return JSON.parse(text);
};
const lacking = async () => Number((await store.pool.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND NOT payload ? 'stage'`)).rows[0].count);

before(async () => {
  store = await withDatabase('backfill-event-stage'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  templateId = (await call('work', adminToken, { title: 'Template', why: 'Its document seeds the ledger.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] })).id;
  await store.pool.query('ALTER TABLE events SET UNLOGGED');
  // Each item: 800 rows of the older shape on a 180 KB document, a full snapshot opening each run of EVERY rows with
  // the next stage and deltas without a stored stage after it.
  for (let index = 0; index < ITEMS; index++) {
    const id = randomUUID(), key = `GY-${index + 100}`;
    items.push({ id, key });
    await store.pool.query(`INSERT INTO work_items(id, document) SELECT $1::uuid, document || jsonb_build_object('id', $1::text, 'key', $2::text) FROM work_items WHERE id=$3`, [id, key, templateId]);
    await store.pool.query(`DO $$ DECLARE doc jsonb; base bigint; st text; r int; BEGIN
      SELECT document || jsonb_build_object('log', (SELECT jsonb_agg(md5(g::text) || ' ' || repeat(md5((g % 97)::text), 2)) FROM generate_series(1, ${KB * 10}) g)) INTO doc FROM work_items WHERE id='${id}';
      FOR r IN 1..${ROWS} LOOP
        st := (ARRAY[${stages.map(stage => `'${stage}'`).join(',')}])[1 + ((r - 1) / ${EVERY}) % ${stages.length}];
        IF (r - 1) % ${EVERY} = 0 THEN
          INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES ('${id}', 'fixture', CASE WHEN r = 1 THEN 'ready' ELSE 'reconciled' END,
            jsonb_build_object('work', jsonb_set(doc, '{stage}', to_jsonb(st))), '${minuteAt(0)}'::timestamptz + make_interval(mins => r)) RETURNING seq INTO base;
        ELSE
          INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES ('${id}', 'fixture', (ARRAY['session','action.claimed','reconciled'])[1 + r % 3],
            jsonb_build_object('delta', jsonb_build_object('base', base, 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('revision'), to_jsonb(r::text)))), 'details', jsonb_build_object('step', r)),
            '${minuteAt(0)}'::timestamptz + make_interval(mins => r));
        END IF;
      END LOOP; END $$`);
  }
  await store.pool.query('ANALYZE events');
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await store?.close();
});

test('integration:backfill-event-stage — loop cycles fill the stage on at most 1,000 older delta rows each until none lack it, each equal to its document\'s stage, and the stage read of 50 items with 800-row chains then answers in under 1 s', { timeout: 600_000 }, async () => {
  const before = await lacking();
  assert.equal(before, ITEMS * (ROWS - ROWS / EVERY));
  const done: string[] = [];
  const cycle = eventStageBackfill(() => call('events/backfill-stage', coordinatorToken, {}));
  let cycles = 0, left = before;
  while (!done.length) {
    assert.ok(++cycles <= Math.ceil(before / 1000) + 2, `the backfill had not finished after ${cycles - 1} cycles`);
    await cycle(line => done.push(line));
    const now = await lacking();
    assert.ok(left - now <= 1000, `one cycle filled ${left - now} rows`);
    left = now;
  }
  assert.equal(left, 0);
  assert.match(done[0], /backfill is done/);
  // Once done, a cycle asks nothing more.
  await cycle(line => done.push(line));
  assert.equal(done.length, 1);
  const differing = await store.pool.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND payload->>'stage' IS DISTINCT FROM graphyard_event_work(work_id, payload)->>'stage'`);
  assert.equal(Number(differing.rows[0].count), 0);

  // The read master status makes, every item at once: each answers in under 1 s with every row's stage.
  const api = (path: string) => call(path, adminToken);
  const timed = await Promise.all(items.map(async item => {
    const started = performance.now();
    const events = await itemLedger(api, item.id);
    return { item, events, ms: performance.now() - started };
  }));
  const slowest = timed.reduce((max, entry) => entry.ms > max.ms ? entry : max);
  assert.ok(slowest.ms < 1000, `${slowest.item.key}'s stage read took ${Math.round(slowest.ms)} ms`);
  for (const { item, events } of timed) {
    assert.ok(events, `${item.key}'s ledger was read`);
    assert.deepEqual(events.map(event => (event as { stage?: string }).stage), Array.from({ length: ROWS }, (_, r) => stageAt(r + 1)), item.key);
  }
});

test('e2e:backfill-event-stage — after the backfill finishes on a running test install, master status shows no events query over 3 s', { timeout: 600_000 }, async () => {
  assert.equal(await lacking(), 0);
  await store.pool.query(`UPDATE work_items SET document = document || jsonb_build_object('stage', 'done', 'delivery', jsonb_build_object('mergedAt', $2::text, 'mergeSha', repeat('a', 40), 'authorizationRevision', 1)) WHERE id = ANY($1::uuid[])`,
    [items.map(item => item.id), minuteAt(ROWS + 10)]);
  const directory = await temporaryDirectory('backfill-event-stage');
  const config = masterConfigSchema.parse({ version: 1, url, repository: 'owner/project', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const root = await temporaryDirectory('backfill-event-stage-root');
  execFileSync('git', ['init', '-q', root]);
  const masterApi = (path: string) => call(path, coordinatorToken);
  const status = await masterStatusReport(root, config, masterApi, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
  assert.deepEqual(status.deliverySpeed.unmeasured, []);
  assert.equal(status.deliverySpeed.readyToMerge?.samples, ITEMS);
  assert.equal((await masterApi('slowest-query?name=SELECT%20seq%2Cwork_id%2Cactor%2Ckind%2Ccreated_at')).slowest, null);
});
