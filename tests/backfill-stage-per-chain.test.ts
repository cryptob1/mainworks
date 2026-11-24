import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { namedPool } from '../src/store/report-pool.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { eventStageBackfill } from '../src/daemon/event-stage-backfill.js';

// GY-3772: each backfilled row rebuilt its 180 KB document from the base, op by op, so batches on long chains still took
// 5 to 27 s and master status could not say how many rows were left. The stage now comes from the base's stage and the
// row's own stage edits, and every batch reports the rows still lacking it.
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const ITEMS = 50, ROWS = 800, KB = 180, EVERY = 100, OPS = 64, TIMEOUT_MS = 5_000;
let store: Store, plain: pg.Pool, http: ReturnType<typeof server>, url: string, root: string;
const call = async (path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${coordinatorToken}`, 'X-Mainworks-Command': 'master status', ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
const lacking = async () => Number((await plain.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND NOT payload ? 'stage'`)).rows[0].count);
const masterStatus = async () => {
  const directory = await temporaryDirectory('backfill-stage-per-chain');
  const config = masterConfigSchema.parse({ version: 1, url, repository: 'owner/project', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  return masterStatusReport(root, config, path => call(path), async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
};

before(async () => {
  const database = await databaseUrl('backfill-stage-per-chain');
  store = new Store(database); await store.init();
  await store.pool.end();
  store.pool = namedPool(database, 12, 10_000, TIMEOUT_MS);
  // The seed and the checks run beside the server's pool, so master status never names them.
  plain = new pg.Pool({ connectionString: database }).on('error', () => {});
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  root = await temporaryDirectory('backfill-stage-per-chain-root');
  execFileSync('git', ['init', '-q', root]);
  await plain.query('ALTER TABLE events SET UNLOGGED');
  // Each item: 800 rows of the older shape on a 180 KB document, a full snapshot opening each run of EVERY rows with its
  // own stage, and deltas of OPS edits without a stored stage after it; every seventh delta also edits the stage.
  for (let index = 0; index < ITEMS; index++) {
    const id = randomUUID();
    await plain.query(`INSERT INTO work_items(id, document) VALUES ($1::uuid, jsonb_build_object('id', $1::text, 'key', $2::text, 'stage', 'ready', 'revision', 1))`, [id, `GY-${index + 100}`]);
    await plain.query(`DO $$ DECLARE doc jsonb; base bigint; r int; BEGIN
      SELECT document || jsonb_build_object('log', (SELECT jsonb_agg(md5(g::text) || ' ' || repeat(md5((g % 97)::text), 2)) FROM generate_series(1, ${KB * 10}) g)) INTO doc FROM work_items WHERE id='${id}';
      FOR r IN 1..${ROWS} LOOP
        IF (r - 1) % ${EVERY} = 0 THEN
          INSERT INTO events(work_id, actor, kind, payload) VALUES ('${id}', 'fixture', 'reconciled', jsonb_build_object('work', jsonb_set(doc, '{stage}', to_jsonb('stage-' || r)))) RETURNING seq INTO base;
        ELSE
          INSERT INTO events(work_id, actor, kind, payload) VALUES ('${id}', 'fixture', 'session',
            jsonb_build_object('delta', jsonb_build_object('base', base, 'ops', (SELECT jsonb_agg(jsonb_build_array(jsonb_build_array('field' || o), to_jsonb(r))) FROM generate_series(1, ${OPS}) o)
              || CASE WHEN r % 7 = 0 THEN jsonb_build_array(jsonb_build_array(jsonb_build_array('stage'), to_jsonb('edited-' || r))) ELSE '[]'::jsonb END)));
        END IF;
      END LOOP; END $$`);
  }
  await plain.query('ANALYZE events');
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await plain?.end(); await store?.close();
});

test('integration:backfill-stage-per-chain — on 50 items of 800-row chains on 180 KB documents the backfill stores every row\'s stage as graphyard_event_work gives it, each batch under 5 s and all in under 5 minutes, while master status shows the remaining rows fall to zero', { timeout: 900_000 }, async () => {
  const before = await lacking();
  assert.equal(before, ITEMS * (ROWS - ROWS / EVERY));
  const lines: string[] = [], batches: { limit: number; filled: number; remaining: number; ms: number }[] = [];
  const cycle = eventStageBackfill(async limit => {
    const started = performance.now();
    const answer = await call('events/backfill-stage', { limit });
    batches.push({ limit, filled: answer.filled, remaining: answer.remaining, ms: performance.now() - started });
    return answer;
  });
  const started = performance.now();
  let left = before;
  const shown: (number | undefined)[] = [];
  while (!lines.some(line => /backfill is done/.test(line))) {
    assert.ok(batches.length < 500, `the backfill had not finished after ${batches.length} cycles`);
    await cycle(line => lines.push(line));
    const batch = batches.at(-1)!, now = await lacking();
    assert.ok(batch.ms < TIMEOUT_MS, `a ${batch.limit}-row batch took ${Math.round(batch.ms)} ms`);
    assert.equal(batch.remaining, now, 'each batch reports the rows still lacking the stage');
    if (batch.filled) assert.match(lines.at(-1)!, new RegExp(`stored ${batch.filled} rows.*, ${now.toLocaleString('en-US')} left`));
    if (batches.length === 1 || !now) shown.push((await masterStatus()).stageBackfill?.remaining);
    left = now;
  }
  const minutes = (performance.now() - started) / 60_000;
  assert.ok(minutes < 5, `the backfill took ${minutes.toFixed(1)} minutes`);
  assert.equal(left, 0);
  assert.ok(shown[0]! > 0 && shown[0]! < before, `master status first showed ${shown[0]} rows left`);
  assert.equal(shown.at(-1), 0);
  const differing = await plain.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND payload->>'stage' IS DISTINCT FROM graphyard_event_work(work_id, payload)->>'stage'`);
  assert.equal(Number(differing.rows[0].count), 0);
  const edited = await plain.query(`SELECT count(*) FROM events WHERE payload->>'stage' LIKE 'edited-%'`);
  assert.ok(Number(edited.rows[0].count) > 0);
});

test('e2e:backfill-stage-per-chain — on a running test install with long delta chains, master status shows the backfill\'s remaining rows at zero and no backfill statement over 5 s', async () => {
  const status = await masterStatus();
  assert.equal(status.stageBackfill?.remaining, 0);
  const slowest = (await call('slowest-query?name=UPDATE%20events%20e%20SET%20payload')).slowest;
  assert.ok(!slowest || slowest.ms < TIMEOUT_MS, `master status names ${JSON.stringify(slowest)}`);
});
