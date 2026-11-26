import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withDatabase } from './helpers/postgres.js';
import { explainAnalyzeBuffers } from './helpers/query-plan.js';
import { listen } from './helpers/http-server.js';
import { workFixture } from './helpers/work-fixture.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { openHumanOnly } from '../src/model/human-request.js';
import type { CostSummary } from '../src/model/token-costs.js';
import type { Principal, Work } from '../src/model.js';

// GY-3945: three read routes read only what they show — /api/human-requests reads open work,
// /api/work-snapshot?view=full requires cursor and pageSize, and /api/costs applies days in SQL.
const admin: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const adminToken = `operator-bounded-${'a'.repeat(32)}`;

const DONE_ITEMS = 2000;
const OLD_USAGE_ROWS = 20_000;
const DAY_MS = 24 * 60 * 60_000;

let store: Store, close: (() => Promise<void>) | undefined, url: string;
let allFixtureWork: Work[] = [];

interface CapturedQuery { text: string; values: unknown[] }

async function captureQueries<T>(pool: pg.Pool, run: () => Promise<T>): Promise<{ result: T; queries: CapturedQuery[] }> {
  const queries: CapturedQuery[] = [];
  const record = (original: (...args: any[]) => any) => function (this: unknown, ...args: any[]) {
    const first = args[0];
    const text = typeof first === 'string' ? first : first?.text ?? '';
    const values = typeof first === 'string' ? (Array.isArray(args[1]) ? args[1] : []) : (Array.isArray(first?.values) ? first.values : []);
    if (text) queries.push({ text, values });
    return original.apply(this, args);
  };
  const p = pool as any;
  const origQuery = p.query, origConnect = p.connect;
  const clients: [any, any][] = [];
  p.query = record(origQuery);
  p.connect = function (...args: any[]) {
    if (typeof args[0] === 'function') return origConnect.apply(this, args);
    return origConnect.apply(this, args).then((client: any) => {
      clients.push([client, client.query]);
      client.query = record(client.query);
      return client;
    });
  };
  try { return { result: await run(), queries }; }
  finally {
    p.query = origQuery;
    p.connect = origConnect;
    for (const [client, own] of clients) client.query = own;
  }
}

const get = async (path: string) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as any };
};

before(async () => {
  store = await withDatabase('three-read-routes-are-bounded');
  await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...admin, token: adminToken }])));

  const now = Date.now();
  const iso = (offsetMs = 0) => new Date(now - offsetMs).toISOString();
  const template = workFixture({
    id: randomUUID(), key: 'GY-1', title: 'Settled item', stage: 'done',
    criteria: [{ id: 'AC-1', text: 'Done', proofs: ['unit:ok'] }],
    gates: [], policy: { checks: [], review: false },
    createdAt: iso(10 * DAY_MS), updatedAt: iso(5 * DAY_MS), stageEnteredAt: iso(5 * DAY_MS),
    delivery: { mergeSha: 'a'.repeat(40), mergedAt: iso(5 * DAY_MS), authorizationRevision: 1 },
  });
  // Seed DONE_ITEMS settled work items in one statement.
  await store.pool.query(
    `INSERT INTO work_items(id, document)
     SELECT g.id, $1::jsonb || jsonb_build_object('id', g.id::text, 'key', 'GY-' || g.n)
     FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${DONE_ITEMS}) n) g`,
    [template],
  );

  // Seed 5 open items (2 with parked human-only requests) and 1 done item with a parked blocker.
  const openPlain = Array.from({ length: 3 }, (_, i) => workFixture({
    id: randomUUID(), key: `GY-${DONE_ITEMS + i + 1}`, title: `Open plain ${i + 1}`, stage: 'build',
    createdAt: iso(2 * DAY_MS), updatedAt: iso(DAY_MS), stageEnteredAt: iso(DAY_MS),
  }));
  const openParked = [0, 1].map(i => workFixture({
    id: randomUUID(), key: `GY-${DONE_ITEMS + 4 + i}`, title: `Open parked ${i + 1}`, stage: 'build',
    blocker: `Needs owner choice ${i + 1}`, blockedAt: iso((i + 1) * 3_600_000),
    humanRequest: {
      id: randomUUID(),
      kind: 'goals-and-priorities',
      reason: `Priority choice ${i + 1}`,
      needed: `Decide priority ${i + 1}`,
      ask: `Decide priority ${i + 1}`,
      requestedBy: 'graphyard-master',
      epoch: 1,
      at: iso((i + 1) * 3_600_000),
    },
    createdAt: iso(2 * DAY_MS), updatedAt: iso(DAY_MS), stageEnteredAt: iso(DAY_MS),
  }));
  const doneParked = workFixture({
    id: randomUUID(), key: `GY-${DONE_ITEMS + 6}`, title: 'Done with stale request', stage: 'done',
    blocker: 'Old parked request on done item', blockedAt: iso(4 * DAY_MS),
    humanRequest: {
      id: randomUUID(),
      kind: 'goals-and-priorities',
      reason: 'Stale priority choice',
      needed: 'Should never appear because item is done',
      ask: 'Should never appear because item is done',
      requestedBy: 'graphyard-master',
      epoch: 1,
      at: iso(4 * DAY_MS),
    },
    createdAt: iso(6 * DAY_MS), updatedAt: iso(4 * DAY_MS), stageEnteredAt: iso(4 * DAY_MS),
    delivery: { mergeSha: 'b'.repeat(40), mergedAt: iso(4 * DAY_MS), authorizationRevision: 1 },
  });
  const extras = [...openPlain, ...openParked, doneParked];
  await store.pool.query(
    `INSERT INTO work_items(id, document) SELECT (d->>'id')::uuid, d FROM jsonb_array_elements($1::jsonb) AS d`,
    [JSON.stringify(extras)],
  );
  allFixtureWork = (await store.pool.query('SELECT document FROM work_items ORDER BY number')).rows.map(r => r.document as Work);

  // Seed session_usage: 20,000 old rows (40..365 days ago) + recent rows in today / 2-6d / 10-25d windows.
  await store.pool.query(
    `INSERT INTO session_usage(id, work, role, account, runtime, model, reported, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
     SELECT 'old-' || n, 'GY-' || (1 + n % 100), 'worker', 'acct-old', 'claude', 'claude-opus-5-5', true,
            1000, 500, 0, 0, now() - interval '40 days' - (n::double precision / ${OLD_USAGE_ROWS}) * interval '325 days'
     FROM generate_series(1, ${OLD_USAGE_ROWS}) n`,
  );
  // 10 rows today (within last hour, safely after UTC midnight or 1 minute ago)
  await store.pool.query(
    `INSERT INTO session_usage(id, work, role, account, runtime, model, reported, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
     SELECT 'today-' || n, 'GY-1', 'worker', 'acct-recent', 'claude', 'claude-opus-5-5', true,
            2000, 1000, 0, 0, now() - interval '1 minute' - n * interval '1 second'
     FROM generate_series(1, 10) n`,
  );
  // 10 rows 3 days ago (in 7-day window, outside today)
  await store.pool.query(
    `INSERT INTO session_usage(id, work, role, account, runtime, model, reported, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
     SELECT 'week-' || n, 'GY-2', 'reviewer', 'acct-recent', 'claude', 'claude-opus-5-5', true,
            3000, 1000, 0, 0, now() - interval '3 days' - n * interval '1 minute'
     FROM generate_series(1, 10) n`,
  );
  // 10 rows 15 days ago (in 30-day window, outside 7-day window)
  await store.pool.query(
    `INSERT INTO session_usage(id, work, role, account, runtime, model, reported, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
     SELECT 'month-' || n, 'GY-3', 'producer', 'acct-recent', 'claude', 'claude-opus-5-5', true,
            4000, 1000, 0, 0, now() - interval '15 days' - n * interval '1 minute'
     FROM generate_series(1, 10) n`,
  );

  await store.pool.query('ANALYZE');
});

after(async () => {
  await close?.();
  await store?.close();
});

test('integration:three-read-routes-are-bounded — /api/human-requests reads open work, work-snapshot?view=full requires paging, and /api/costs applies days in SQL without whole-table sequential scans', async () => {
  // 1. /api/human-requests: reads only open work, returns the same rows as openHumanOnly over all items, no seq scan.
  {
    const { result, queries } = await captureQueries(store.pool, () => get('human-requests'));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const expected = openHumanOnly(allFixtureWork.filter(w => w.stage !== 'done').map(work => ({ work })), Date.parse(result.body.now));
    assert.equal(result.body.requests.length, 2, 'only the two open parked requests are returned');
    assert.deepEqual(
      result.body.requests,
      expected,
      'returns the same rows as openHumanOnly on the full fixture',
    );
    const tableQueries = queries.filter(q => /\b(work_items|work_index)\b/i.test(q.text));
    assert.ok(tableQueries.length > 0, 'human-requests queried the database');
    for (const q of tableQueries) {
      assert.doesNotMatch(q.text, /jsonb_agg\(document/i, `human-requests must not aggregate all work_items: ${q.text}`);
      const plan = await explainAnalyzeBuffers(store.pool, q.text, q.values);
      assert.ok(!plan.seqScans.includes('work_items'), `human-requests must not seq-scan work_items: ${plan.summary}`);
      assert.ok(!plan.seqScans.includes('work_index'), `human-requests must not seq-scan work_index: ${plan.summary}`);
      assert.ok(plan.rowsScanned('work_items') <= 20, `human-requests scanned ${plan.rowsScanned('work_items')} work_items: ${plan.summary}`);
    }
  }

  // 2. /api/work-snapshot?view=full: requires both pageSize and cursor, answers 400 with one line without them, and pages without whole-table seq scan.
  {
    for (const bad of ['work-snapshot?view=full', 'work-snapshot?view=full&pageSize=10', 'work-snapshot?view=full&cursor=0']) {
      const refused = await get(bad);
      assert.equal(refused.status, 400, `${bad} must answer 400, got ${refused.status}`);
      assert.equal(typeof refused.body.error, 'string', `${bad} returns an error message`);
      assert.ok(refused.body.error.length > 0 && !refused.body.error.includes('\n'), `${bad} answers with one line: ${JSON.stringify(refused.body.error)}`);
    }
    const { result, queries } = await captureQueries(store.pool, () => get('work-snapshot?view=full&cursor=0&pageSize=10'));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.work.length, 10);
    assert.equal(result.body.hasMore, true);
    assert.equal(typeof result.body.nextCursor, 'number');
    const tableQueries = queries.filter(q => /^\s*SELECT\b/i.test(q.text) && /\b(work_items|work_index)\b/i.test(q.text));
    assert.ok(tableQueries.length > 0, 'paged full snapshot queried work_items');
    for (const q of tableQueries) {
      const plan = await explainAnalyzeBuffers(store.pool, q.text, q.values);
      assert.ok(!plan.seqScans.includes('work_items'), `paged full snapshot must not seq-scan work_items: ${plan.summary}`);
      assert.ok(!plan.seqScans.includes('work_index'), `paged full snapshot must not seq-scan work_index: ${plan.summary}`);
      assert.ok(plan.rowsScanned('work_items') <= 25, `paged full snapshot scanned ${plan.rowsScanned('work_items')} work_items: ${plan.summary}`);
    }
  }

  // 3. /api/costs?days=N: applies days in SQL without seq-scanning session_usage; today/week/month keep their own windows.
  {
    const { result: seven, queries: sevenQueries } = await captureQueries(store.pool, () => get('costs?days=7'));
    assert.equal(seven.status, 200, JSON.stringify(seven.body));
    const summary7 = seven.body as CostSummary;
    assert.equal(summary7.days, 7);
    // 10 today rows (2000+1000=3000 each = 30,000) + 10 week rows (3000+1000=4000 each = 40,000) = 70,000 tokens
    const tokens = (l: { input: number; output: number; cacheRead: number; cacheWrite: number }) => l.input + l.output + l.cacheRead + l.cacheWrite;
    assert.equal(tokens(summary7.windows.all), 70_000, 'days=7 window includes only today + 3-day rows, not 15-day or 40+-day rows');
    assert.equal(tokens(summary7.windows.week), 70_000, 'week window has 70,000 tokens');
    assert.equal(tokens(summary7.windows.today), 30_000, 'today window keeps its own window (30,000 tokens)');
    assert.deepEqual(summary7.roles.map(r => r.name).sort(), ['Reviewers', 'Workers'], 'days=7 roles exclude 15-day producer rows');

    const usageQueries7 = sevenQueries.filter(q => /\bsession_usage\b/i.test(q.text));
    assert.ok(usageQueries7.length > 0, 'costs?days=7 queried session_usage');
    for (const q of usageQueries7) {
      const plan = await explainAnalyzeBuffers(store.pool, q.text, q.values);
      assert.ok(!plan.seqScans.includes('session_usage'), `costs?days=7 must not seq-scan session_usage: ${plan.summary}`);
      assert.ok(plan.rowsScanned('session_usage') <= 50, `costs?days=7 scanned ${plan.rowsScanned('session_usage')} session_usage rows: ${plan.summary}`);
    }

    const { result: thirty, queries: thirtyQueries } = await captureQueries(store.pool, () => get('costs?days=30'));
    assert.equal(thirty.status, 200, JSON.stringify(thirty.body));
    const summary30 = thirty.body as CostSummary;
    // 30,000 (today) + 40,000 (3d) + 50,000 (15d) = 120,000
    assert.equal(tokens(summary30.windows.all), 120_000, 'days=30 includes 15-day rows and excludes 40+-day rows');
    assert.equal(tokens(summary30.windows.month), 120_000, 'month window has 120,000 tokens');
    assert.equal(tokens(summary30.windows.week), 70_000, 'week window keeps its own 7-day window');
    assert.equal(tokens(summary30.windows.today), 30_000, 'today window keeps its own today window');
    const usageQueries30 = thirtyQueries.filter(q => /\bsession_usage\b/i.test(q.text));
    for (const q of usageQueries30) {
      const plan = await explainAnalyzeBuffers(store.pool, q.text, q.values);
      assert.ok(!plan.seqScans.includes('session_usage'), `costs?days=30 must not seq-scan session_usage: ${plan.summary}`);
      assert.ok(plan.rowsScanned('session_usage') <= 50, `costs?days=30 scanned ${plan.rowsScanned('session_usage')} session_usage rows: ${plan.summary}`);
    }
  }
});
