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

// GY-3774: backfillEventStage ran a full-table count(*) inside every batch's transaction, and eventStageBackfill
// sized the next batch from the whole call's duration. A slow count drove batches down to 1 row.
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const ITEMS = 100, DELTAS_PER_ITEM = 5_000, TIMEOUT_MS = 5_000;
let store: Store, plain: pg.Pool, http: ReturnType<typeof server>, url: string, root: string;
let countQueries = 0, countDelayMs = 0;

const call = async (path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Bearer ${coordinatorToken}`,
      'X-Mainworks-Command': 'master status',
      ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const lacking = async (pool = plain) =>
  Number((await pool.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND NOT payload ? 'stage'`)).rows[0].count);

const masterStatus = async (serverUrl = url) => {
  const directory = await temporaryDirectory('backfill-count-off-batch');
  const config = masterConfigSchema.parse({
    version: 1, url: serverUrl, repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard',
    hostId: 'test-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master',
    workers: [], run: { masterHeartbeatMinutes: 240 },
  });
  return masterStatusReport(
    root, config,
    async path => {
      const response = await fetch(`${serverUrl}/api/${path}`, {
        headers: { Authorization: `Bearer ${coordinatorToken}`, 'X-Mainworks-Command': 'master status' },
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`);
      return JSON.parse(text);
    },
    async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`,
  );
};

function instrumentCountQueries(pool: pg.Pool) {
  pool.on('connect', client => {
    const original = client.query.bind(client) as (...args: any[]) => any;
    (client as unknown as { query: (...args: any[]) => any }).query = (...args: any[]) => {
      const config = args[0];
      const text = typeof config === 'string' ? config : (config as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && /SELECT\s+count\s*\(/i.test(text) && /events/i.test(text)) {
        countQueries++;
        if (countDelayMs > 0 && typeof args[args.length - 1] !== 'function') {
          const delay = countDelayMs;
          return new Promise(resolve => setTimeout(resolve, delay)).then(() => original(...args));
        }
      }
      return original(...args);
    };
  });
}

before(async () => {
  const database = await databaseUrl('backfill-count-off-batch');
  store = new Store(database);
  await store.init();
  await store.pool.end();
  store.pool = namedPool(database, 12, 10_000, TIMEOUT_MS);
  instrumentCountQueries(store.pool);
  plain = new pg.Pool({ connectionString: database }).on('error', () => {});
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  http = server(engine, [{ id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  root = await temporaryDirectory('backfill-count-off-batch-root');
  execFileSync('git', ['init', '-q', root]);

  await plain.query('ALTER TABLE events SET UNLOGGED');
  // Seed 500,000 delta rows lacking stage across 100 items, with every 50th delta editing stage.
  await plain.query(`DO $$
    DECLARE
      i int;
      wid uuid;
      base bigint;
    BEGIN
      FOR i IN 1..${ITEMS} LOOP
        wid := gen_random_uuid();
        INSERT INTO work_items(id, document)
          VALUES (wid, jsonb_build_object('id', wid::text, 'key', 'GY-' || (1000 + i), 'stage', 'stage-' || i, 'revision', 1));
        INSERT INTO events(work_id, actor, kind, payload)
          VALUES (wid, 'fixture', 'reconciled',
            jsonb_build_object('work', jsonb_build_object('id', wid::text, 'key', 'GY-' || (1000 + i), 'stage', 'stage-' || i, 'revision', 1)))
          RETURNING seq INTO base;
        INSERT INTO events(work_id, actor, kind, payload)
          SELECT wid, 'fixture', 'session',
            jsonb_build_object('delta', jsonb_build_object(
              'base', base,
              'ops', CASE WHEN g % 50 = 0
                THEN jsonb_build_array(jsonb_build_array(jsonb_build_array('revision'), to_jsonb(g)), jsonb_build_array(jsonb_build_array('stage'), to_jsonb('edited-' || g)))
                ELSE jsonb_build_array(jsonb_build_array(jsonb_build_array('revision'), to_jsonb(g)))
              END
            ))
          FROM generate_series(1, ${DELTAS_PER_ITEM}) g;
      END LOOP;
    END $$`);
  await plain.query('ANALYZE events');
});

after(async () => {
  http?.closeAllConnections();
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await plain?.end();
  await store?.close();
});

test('integration:backfill-count-off-batch — on 500,000 stageless delta rows, a slow count never shrinks batches to 1 row, each sized batch fills >= 100 rows under 5 s, remaining is within 1% and counted at most once a minute, and every stored stage matches graphyard_event_work', { timeout: 600_000 }, async () => {
  const initial = await lacking();
  assert.equal(initial, ITEMS * DELTAS_PER_ITEM);
  assert.ok(initial >= 500_000);

  countQueries = 0;
  // A 2.5 s count (under the 5 s timeout) shrinks batches 50 -> 20 -> 8 -> 3 -> 1 on the base tip.
  countDelayMs = 2_500;
  const started = performance.now();
  const batches: { limit: number; filled: number; remaining?: number; updateMs?: number; callMs: number }[] = [];
  const cycle = eventStageBackfill(async limit => {
    const t0 = performance.now();
    const answer = await call('events/backfill-stage', { limit });
    batches.push({ limit, filled: answer.filled, remaining: answer.remaining, updateMs: answer.updateMs, callMs: performance.now() - t0 });
    return answer;
  });

  for (let i = 0; i < 8; i++) await cycle(() => {});
  countDelayMs = 0;
  for (let i = 0; i < 12; i++) await cycle(() => {});

  const elapsedMs = performance.now() - started;
  const maxAllowedCounts = Math.floor(elapsedMs / 60_000) + 1;
  assert.ok(countQueries <= maxAllowedCounts, `expected remaining count at most once a minute (<= ${maxAllowedCounts}), ran ${countQueries} times in ${Math.round(elapsedMs)} ms`);

  // Every batch after the initial 50-row batch is sized from the UPDATE alone and fills >= 100 rows.
  for (let i = 1; i < batches.length; i++) {
    assert.ok(batches[i].filled >= 100, `batch ${i + 1} (limit ${batches[i].limit}) filled only ${batches[i].filled} rows`);
  }

  // No batch statement took over 5 seconds.
  const slowest = (await call('slowest-query?name=WITH%20batch%20AS%20(SELECT%20seq%2C%20work_id')).slowest;
  assert.ok(!slowest || slowest.ms < TIMEOUT_MS, `slowest backfill statement was ${JSON.stringify(slowest)}`);
  const slowestCount = (await call('slowest-query?name=SELECT%20count(*)')).slowest;
  assert.ok(!slowestCount || slowestCount.ms < TIMEOUT_MS, `slowest count statement was ${JSON.stringify(slowestCount)}`);

  // Remaining shown in master status is within 1% of the true count.
  const actualRemaining = await lacking();
  const shown = (await masterStatus()).stageBackfill?.remaining;
  assert.equal(typeof shown, 'number', 'master status reports stageBackfill.remaining');
  const diff = Math.abs(shown! - actualRemaining);
  assert.ok(diff <= actualRemaining * 0.01, `master status remaining ${shown} differs from true count ${actualRemaining} by ${diff} (> 1%)`);

  // Every stored stage equals graphyard_event_work's.
  const differing = await plain.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND payload ? 'stage'
    AND payload->>'stage' IS DISTINCT FROM graphyard_event_work(work_id, payload)->>'stage'`);
  assert.equal(Number(differing.rows[0].count), 0);
  const edited = await plain.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND payload->>'stage' LIKE 'edited-%'`);
  assert.ok(Number(edited.rows[0].count) > 0, 'stage edits from delta ops were stored');
});

test('e2e:backfill-count-off-batch — on a running test install the backfill remaining rows fall by at least 1,000 within ten loop cycles and reach zero', { timeout: 600_000 }, async () => {
  const database = await databaseUrl('backfill-count-off-batch-e2e');
  const e2eStore = new Store(database);
  await e2eStore.init();
  await e2eStore.pool.end();
  e2eStore.pool = namedPool(database, 12, 10_000, TIMEOUT_MS);
  const e2ePlain = new pg.Pool({ connectionString: database }).on('error', () => {});
  const engine = new Engine(e2eStore, 120, 'owner/project');
  engine.gitRunner = null;
  const e2eHttp = server(engine, [{ id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => e2eHttp.listen(0, '127.0.0.1', resolve));
  const e2eUrl = `http://127.0.0.1:${(e2eHttp.address() as { port: number }).port}`;
  const e2eCall = async (path: string, body?: unknown) => {
    const response = await fetch(`${e2eUrl}/api/${path}`, {
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(120_000),
      headers: {
        Authorization: `Bearer ${coordinatorToken}`,
        'X-Mainworks-Command': 'master status',
        ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  try {
    await e2ePlain.query('ALTER TABLE events SET UNLOGGED');
    const SEED_ROWS = 12_000;
    await e2ePlain.query(`DO $$
      DECLARE wid uuid := gen_random_uuid(); base bigint;
      BEGIN
        INSERT INTO work_items(id, document) VALUES (wid, jsonb_build_object('id', wid::text, 'key', 'GY-9001', 'stage', 'ready', 'revision', 1));
        INSERT INTO events(work_id, actor, kind, payload)
          VALUES (wid, 'fixture', 'reconciled', jsonb_build_object('work', jsonb_build_object('id', wid::text, 'key', 'GY-9001', 'stage', 'ready', 'revision', 1)))
          RETURNING seq INTO base;
        INSERT INTO events(work_id, actor, kind, payload)
          SELECT wid, 'fixture', 'session',
            jsonb_build_object('delta', jsonb_build_object('base', base, 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('revision'), to_jsonb(g)))))
          FROM generate_series(1, ${SEED_ROWS}) g;
      END $$`);
    await e2ePlain.query('ANALYZE events');

    const lines: string[] = [];
    const cycle = eventStageBackfill(limit => e2eCall('events/backfill-stage', { limit }));
    let cycles = 0, remainingAfterTen: number | undefined;
    while (!lines.some(line => /backfill is done/.test(line))) {
      assert.ok(++cycles < 100, `the backfill had not finished after ${cycles} cycles`);
      await cycle(line => lines.push(line));
      if (cycles === 10) remainingAfterTen = (await masterStatus(e2eUrl)).stageBackfill?.remaining;
    }
    const finalStatus = await masterStatus(e2eUrl);
    const afterTen = remainingAfterTen ?? finalStatus.stageBackfill?.remaining ?? 0;
    assert.ok(SEED_ROWS - afterTen >= 1_000, `expected remaining to fall by >= 1,000 within 10 cycles, fell by ${SEED_ROWS - afterTen}`);
    assert.equal(finalStatus.stageBackfill?.remaining, 0);
    assert.equal(await lacking(e2ePlain), 0);
  } finally {
    e2eHttp.closeAllConnections();
    await new Promise<void>(resolve => e2eHttp.close(() => resolve()));
    await e2ePlain.end();
    await e2eStore.close();
  }
});
