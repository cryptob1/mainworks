import { test } from 'node:test';
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

// GY-3777: after GY-3774, the backfill still re-ran the 23-28 s remaining-rows count once a minute
// and sized batches to 1 s, keeping throughput at ~44,000 rows/hour. It now counts remaining once
// per loop start, subtracts each batch's filled rows, and sizes batches to ~3 s.
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const ITEMS = 100, DELTAS_PER_ITEM = 5_000, TIMEOUT_MS = 5_000;
const CYCLE_OVERHEAD_MS = 10_000;
const CORE_COUNT_MS = 25_000;
const PER_ROW_MS = 4;

const apiCall = async (baseUrl: string, path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}/api/${path}`, {
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

const lacking = async (pool: pg.Pool) =>
  Number((await pool.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND NOT payload ? 'stage'`)).rows[0].count);

const masterStatus = async (serverUrl: string, root: string) => {
  const directory = await temporaryDirectory('backfill-faster');
  const config = masterConfigSchema.parse({
    version: 1, url: serverUrl, repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard',
    hostId: 'test-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master',
    workers: [], run: { masterHeartbeatMinutes: 240 },
  });
  return masterStatusReport(
    root, config,
    path => apiCall(serverUrl, path),
    async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`,
  );
};

test('integration:backfill-faster — on 500,000 stageless delta rows, the backfill runs the full remaining count only once per loop start, subtracts filled rows (exact at the end), keeps every batch under 5 s, and fills >= 2.5x as many rows per minute as the base tip', { timeout: 600_000 }, async () => {
  const database = await databaseUrl('backfill-faster');
  const store = new Store(database);
  await store.init();
  await store.pool.end();
  store.pool = namedPool(database, 12, 10_000, TIMEOUT_MS);
  let countQueries = 0;
  let simulateRowMs = 0;
  store.pool.on('connect', client => {
    const original = client.query.bind(client) as (...args: any[]) => any;
    (client as unknown as { query: (...args: any[]) => any }).query = (...args: any[]) => {
      const config = args[0];
      const text = typeof config === 'string' ? config : (config as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && /SELECT\s+count\s*\(/i.test(text) && /events/i.test(text)) {
        countQueries++;
      }
      if (simulateRowMs > 0 && typeof text === 'string' && /WITH\s+batch\s+AS/i.test(text) && Array.isArray(args[1]) && typeof args[1][0] === 'number' && typeof args[args.length - 1] !== 'function') {
        const delay = args[1][0] * simulateRowMs;
        return new Promise(resolve => setTimeout(resolve, delay)).then(() => original(...args));
      }
      return original(...args);
    };
  });
  const plain = new pg.Pool({ connectionString: database }).on('error', () => {});
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  const http = server(engine, [{ id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const root = await temporaryDirectory('backfill-faster-root');
  execFileSync('git', ['init', '-q', root]);

  const realNow = Date.now;
  let nowOffsetMs = 0;
  Date.now = () => realNow() + nowOffsetMs;

  try {
    await plain.query('ALTER TABLE events SET UNLOGGED');
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

    const initial = await lacking(plain);
    assert.equal(initial, ITEMS * DELTAS_PER_ITEM);
    assert.ok(initial >= 500_000);

    // Base tip steady-state rate model (targetMs = 1_000, 25 s count once a minute, 10 s cycle overhead, 4 ms/row):
    // 1 s batch fills 250 rows; each cycle takes 11 s; 1 minute minus 25 s count fits 35/11 cycles -> ~795 rows/min.
    const baseTipRowsPerMin = ((60_000 - CORE_COUNT_MS) / (1_000 + CYCLE_OVERHEAD_MS)) * (1_000 / PER_ROW_MS);

    countQueries = 0;
    simulateRowMs = PER_ROW_MS;
    let totalFilled = 0;
    let simulatedMs = 0;
    let steadyFilled = 0;
    let steadyMs = 0;
    const batches: { limit: number; filled: number; remaining?: number; updateMs?: number }[] = [];

    const runLoop = () => eventStageBackfill(async (limit, recount) => {
      const countsBefore = countQueries;
      const answer = await apiCall(url, 'events/backfill-stage', recount ? { limit, recount: true } : { limit });
      const ranCount = countQueries > countsBefore;
      const batchMs = answer.updateMs ?? 0;
      const cycleMs = CYCLE_OVERHEAD_MS + batchMs + (ranCount ? CORE_COUNT_MS : 0);
      nowOffsetMs += cycleMs;
      simulatedMs += cycleMs;
      if (batches.length >= 1) {
        steadyFilled += answer.filled;
        steadyMs += cycleMs;
      }
      totalFilled += answer.filled;
      batches.push({ limit, filled: answer.filled, remaining: answer.remaining, updateMs: answer.updateMs });
      return answer;
    });

    // Loop 1: run 8 cycles spanning well over 1 minute of simulated loop time.
    const loop1 = runLoop();
    for (let i = 0; i < 8; i++) {
      await loop1(() => {});
      const last = batches.at(-1)!;
      assert.equal(last.remaining, initial - totalFilled, `batch ${batches.length} remaining ${last.remaining} should equal initial - filled (${initial - totalFilled})`);
      assert.ok((last.updateMs ?? 0) < TIMEOUT_MS, `batch ${batches.length} (limit ${last.limit}) took ${Math.round(last.updateMs ?? 0)} ms (>= 5 s)`);
    }

    // Over 1 minute of simulated time elapsed, yet the full remaining count ran ONLY once for loop 1.
    assert.ok(simulatedMs > 90_000, `expected > 90 s simulated time, got ${simulatedMs} ms`);
    assert.equal(countQueries, 1, `expected full remaining count only once for loop 1, ran ${countQueries} times`);

    // Steady-state throughput must be at least 2.5x the base tip's rows/min.
    const rowsPerMin = (steadyFilled / steadyMs) * 60_000;
    assert.ok(
      rowsPerMin >= baseTipRowsPerMin * 2.5,
      `expected >= ${(baseTipRowsPerMin * 2.5).toFixed(0)} rows/min (2.5x base tip ${baseTipRowsPerMin.toFixed(0)}), got ${rowsPerMin.toFixed(0)} rows/min`,
    );

    // Loop 2 (simulating a loop restart): recounts once at start, then subtracts without recounting even past 60 s.
    simulateRowMs = 0;
    const loop2 = runLoop();
    for (let i = 0; i < 4; i++) {
      nowOffsetMs += 70_000;
      await loop2(() => {});
      const last = batches.at(-1)!;
      assert.equal(last.remaining, initial - totalFilled, `loop 2 batch ${i + 1} remaining ${last.remaining} should equal ${initial - totalFilled}`);
    }
    assert.equal(countQueries, 2, `expected exactly one additional count on loop restart (total 2), got ${countQueries}`);

    // Master status matches the exact remaining count.
    const actualRemaining = await lacking(plain);
    assert.equal(actualRemaining, initial - totalFilled);
    const shown = (await masterStatus(url, root)).stageBackfill?.remaining;
    assert.equal(shown, actualRemaining);

    // No batch statement took over 5 seconds.
    const slowest = (await apiCall(url, 'slowest-query?name=WITH%20batch%20AS%20(SELECT%20seq%2C%20work_id')).slowest;
    assert.ok(!slowest || slowest.ms < TIMEOUT_MS, `slowest backfill statement was ${JSON.stringify(slowest)}`);

    // Stored stages match graphyard_event_work.
    const differing = await plain.query(`SELECT count(*) FROM events WHERE payload ? 'delta' AND payload ? 'stage'
      AND payload->>'stage' IS DISTINCT FROM graphyard_event_work(work_id, payload)->>'stage'`);
    assert.equal(Number(differing.rows[0].count), 0);

    // A slow batch under host load does not collapse batch size below the 250-row floor, while a non-recount timeout backs off.
    // A first-cycle timeout (on the one-time count) neither shrinks the batch nor re-requests recount on the next cycle.
    const firstTimeoutCalls: { limit: number; recount?: boolean }[] = [];
    const firstTimeout = eventStageBackfill(async (limit, recount) => {
      firstTimeoutCalls.push({ limit, recount });
      if (firstTimeoutCalls.length === 1) throw new Error('The operation was aborted due to timeout');
      return { filled: limit, remaining: 10_000, updateMs: 50 };
    });
    await assert.rejects(() => firstTimeout(() => {}), /aborted due to timeout/);
    await firstTimeout(() => {});
    assert.deepEqual(firstTimeoutCalls, [{ limit: 50, recount: true }, { limit: 50, recount: false }]);

    const spikedLimits: number[] = [];
    let shouldFail = false;
    const spiked = eventStageBackfill(async limit => {
      spikedLimits.push(limit);
      if (shouldFail) throw new Error('statement timeout');
      return { filled: limit, remaining: 10_000, updateMs: 12_000 };
    });
    await spiked(() => {});
    await spiked(() => {});
    assert.equal(spikedLimits[0], 50);
    assert.ok(spikedLimits[1] >= 250, `expected load-spike batch floor >= 250, got ${spikedLimits[1]}`);
    shouldFail = true;
    await assert.rejects(() => spiked(() => {}), /statement timeout/);
    shouldFail = false;
    await spiked(() => {});
    assert.ok(spikedLimits[3] < 250, `expected backoff after timeout error, got ${spikedLimits[3]}`);
  } finally {
    Date.now = realNow;
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await plain.end();
    await store.close();
  }
});

test('e2e:backfill-faster — on a running test install the backfill reaches zero remaining with one full count logged and no backfill statement over 5 seconds', { timeout: 600_000 }, async () => {
  const database = await databaseUrl('backfill-faster-e2e');
  const e2eStore = new Store(database);
  await e2eStore.init();
  await e2eStore.pool.end();
  e2eStore.pool = namedPool(database, 12, 10_000, TIMEOUT_MS);
  let countQueries = 0;
  e2eStore.pool.on('connect', client => {
    const original = client.query.bind(client) as (...args: any[]) => any;
    (client as unknown as { query: (...args: any[]) => any }).query = (...args: any[]) => {
      const config = args[0];
      const text = typeof config === 'string' ? config : (config as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && /SELECT\s+count\s*\(/i.test(text) && /events/i.test(text)) countQueries++;
      return original(...args);
    };
  });
  const e2ePlain = new pg.Pool({ connectionString: database }).on('error', () => {});
  const engine = new Engine(e2eStore, 120, 'owner/project');
  engine.gitRunner = null;
  const e2eHttp = server(engine, [{ id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => e2eHttp.listen(0, '127.0.0.1', resolve));
  const e2eUrl = `http://127.0.0.1:${(e2eHttp.address() as { port: number }).port}`;
  const e2eRoot = await temporaryDirectory('backfill-faster-e2e-root');
  execFileSync('git', ['init', '-q', e2eRoot]);

  const realNow = Date.now;
  let nowOffsetMs = 0;
  Date.now = () => realNow() + nowOffsetMs;

  try {
    await e2ePlain.query('ALTER TABLE events SET UNLOGGED');
    const SEED_ROWS = 12_000;
    await e2ePlain.query(`DO $$
      DECLARE wid uuid := gen_random_uuid(); base bigint;
      BEGIN
        INSERT INTO work_items(id, document) VALUES (wid, jsonb_build_object('id', wid::text, 'key', 'GY-9002', 'stage', 'ready', 'revision', 1));
        INSERT INTO events(work_id, actor, kind, payload)
          VALUES (wid, 'fixture', 'reconciled', jsonb_build_object('work', jsonb_build_object('id', wid::text, 'key', 'GY-9002', 'stage', 'ready', 'revision', 1)))
          RETURNING seq INTO base;
        INSERT INTO events(work_id, actor, kind, payload)
          SELECT wid, 'fixture', 'session',
            jsonb_build_object('delta', jsonb_build_object('base', base, 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('revision'), to_jsonb(g)))))
          FROM generate_series(1, ${SEED_ROWS}) g;
      END $$`);
    await e2ePlain.query('ANALYZE events');

    countQueries = 0;
    const lines: string[] = [];
    const cycle = eventStageBackfill((limit, recount) =>
      apiCall(e2eUrl, 'events/backfill-stage', recount ? { limit, recount: true } : { limit }),
    );
    let cycles = 0;
    while (!lines.some(line => /backfill is done/.test(line))) {
      assert.ok(++cycles < 100, `the backfill had not finished after ${cycles} cycles`);
      await cycle(line => lines.push(line));
      nowOffsetMs += 70_000;
    }

    assert.equal(countQueries, 1, `expected exactly one full count over the backfill, ran ${countQueries} times`);
    const finalStatus = await masterStatus(e2eUrl, e2eRoot);
    assert.equal(finalStatus.stageBackfill?.remaining, 0);
    assert.equal(await lacking(e2ePlain), 0);
    const slowest = (await apiCall(e2eUrl, 'slowest-query?name=WITH%20batch%20AS%20(SELECT%20seq%2C%20work_id')).slowest;
    assert.ok(!slowest || slowest.ms < TIMEOUT_MS, `slowest backfill statement was ${JSON.stringify(slowest)}`);
  } finally {
    Date.now = realNow;
    e2eHttp.closeAllConnections();
    await new Promise<void>(resolve => e2eHttp.close(() => resolve()));
    await e2ePlain.end();
    await e2eStore.close();
  }
});
