import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import type { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { flowAttemptsSql, flowLedgerSql, forgetFlow } from '../src/server/flow.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { queryName } from '../src/store/slow-queries.js';
import { workTables } from '../src/store/tables/work.js';

// GY-3765: on the live install the flow's ledger read took about 9 s every minute: each of the
// window's whole-document rows was read whole for its stage. The read now takes the stage, kind and
// times without opening any stored document but a rework's.
const adminToken = `operator-${'a'.repeat(32)}`;
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const ITEMS = 2000, EVENTS = 2_000_000, WHOLE_EVERY = 40, TIMELINE = 1200;
const flowKinds = ['rework', 'merge.intent', 'merge.trial', 'merge.refused', 'merge.serve-revert'];
// The statement as it stood before GY-3765, for the rows it returned.
const columns = `work_id, kind, created_at, seq,
    CASE WHEN payload ? 'work' THEN payload->'work'->>'stage' END AS stage,
    CASE WHEN kind = 'rework' THEN COALESCE(payload->'details'->>'reason', payload->'details'->'intent'->>'reason')
      WHEN kind = 'merge.refused' THEN payload->>'reason' END AS reason,
    CASE WHEN kind = 'rework' THEN COALESCE(payload->'details'->>'binding', payload->'details'->'intent'->>'binding') END AS binding,
    CASE WHEN kind IN ('merge.trial', 'merge.refused') THEN payload->>'head' END AS head,
    CASE WHEN kind = 'merge.trial' THEN payload->>'durationMs' END AS duration_ms,
    CASE WHEN kind = 'merge.trial' THEN payload ? 'flaked' END AS flaked,
    CASE WHEN kind = 'merge.serve-revert' THEN payload->>'outcome' = 'reverted' END AS reverted`;
const previousLedgerSql = `SELECT ${columns} FROM events WHERE work_id IS NOT NULL AND created_at > $1 AND payload ? 'work'
  UNION ALL SELECT ${columns} FROM events WHERE work_id IS NOT NULL AND created_at > $1 AND kind = ANY($2::text[]) AND NOT (payload ? 'work')
  ORDER BY seq`;
let store: Store, http: ReturnType<typeof server>, url: string;
// The fixture's own statements run on a plain client, outside the timed pools, so the server's slowest-query report holds only what the server ran.
let fixture: pg.Client;

before(async () => {
  store = await withDatabase('flow-ledger-fast'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Template', why: 'Flow is measured.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  const { id } = await created.json() as { id: string };
  fixture = new pg.Client({ connectionString: (store.pool as unknown as { options: { connectionString: string } }).options.connectionString }); await fixture.connect();
  const template = (await fixture.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document;
  await fixture.query(`INSERT INTO work_items(id, document) SELECT g.id, $1::jsonb || jsonb_build_object('id', g.id::text, 'key', 'GY-' || (g.n + 100), 'stage', 'build')
    FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${ITEMS}) n) g`, [template]);
  // The ledger as a release before GY-3765 left it: rows carry no stage until the migration below fills the window's.
  await fixture.query('DROP TRIGGER IF EXISTS event_stage ON events; ALTER TABLE events DROP COLUMN IF EXISTS stage; ALTER TABLE events SET UNLOGGED');
  // Two million events over the last 7 days. As on the live ledger most are heartbeats and observations; one in fifty a trial, an intent
  // or a refusal; one in forty a save carrying the item's whole document (about 80 kB, a rework's with its reason and binding).
  await fixture.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
    SELECT ids[1 + d % array_length(ids, 1)], 'fixture', k.kind,
      CASE WHEN d % ${WHOLE_EVERY} = 3 THEN jsonb_build_object('work', $1::jsonb || jsonb_build_object('stage', (ARRAY['build','review','test','merge'])[1 + d % 4],
          'timeline', b.blobs[1 + d % 32]),
        'details', CASE WHEN k.kind = 'rework' THEN jsonb_build_object('reason', 'Rework ' || d, 'binding', d % 2 = 0) END)
      ELSE jsonb_build_object('head', md5(d::text), 'durationMs', 600000, 'reason', 'Refused ' || d) END,
      now() - interval '7 days' + interval '15 minutes' + make_interval(secs => d * (7 * 86400 - 1800)::float8 / ${EVENTS})
    FROM (SELECT array_agg(i.id) AS ids FROM work_index i WHERE NOT i.settled) i, generate_series(1, ${EVENTS}) d,
      (SELECT array_agg((SELECT jsonb_agg(md5(v || ':' || n) || md5(n || ':' || v)) FROM generate_series(1, ${TIMELINE}) n)) AS blobs FROM generate_series(1, 32) v) b,
      LATERAL (SELECT CASE WHEN d % ${WHOLE_EVERY} = 3 THEN (CASE WHEN d % 7 = 0 THEN 'rework' ELSE 'work.saved' END)
        ELSE CASE d % 50 WHEN 0 THEN 'merge.trial' WHEN 1 THEN 'merge.intent' WHEN 2 THEN 'merge.refused' ELSE (ARRAY['heartbeat','github.observed'])[1 + d % 2] END END AS kind) k`, [template]);
  await fixture.query(workTables.find(table => table.name === 'events')!.ddl);
  await fixture.query('VACUUM ANALYZE events'); await fixture.query('ANALYZE work_items'); await fixture.query('ANALYZE work_index');
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await fixture?.end(); await store?.close();
});

const plain = (rows: any[]) => rows.map(row => ({ ...row, created_at: row.created_at.toISOString() }));

test('integration:flow-ledger-fast — on two million events over 7 days with large stored documents, the ledger read answers in under 3 s with the same rows as before', { timeout: 900_000 }, async () => {
  assert.ok(Number((await fixture.query('SELECT count(*) FROM events WHERE created_at > now() - interval \'7 days\'')).rows[0].count) >= EVENTS);
  assert.ok(Number((await fixture.query(`SELECT avg(pg_column_size(payload)) FROM events WHERE kind IN ('work.saved', 'rework')`)).rows[0].avg) > 60_000, 'stored documents are large');
  const since = new Date(Date.now() - 7 * 86_400_000);
  const previous = plain((await fixture.query(previousLedgerSql, [since, flowKinds])).rows);
  assert.ok(previous.length > EVENTS / WHOLE_EVERY, 'the window\'s saves and flow kinds');
  assert.ok(previous.some(row => row.kind === 'rework' && row.reason && row.stage));

  const client = await store.pool.connect();
  try {
    await client.query(`SET statement_timeout = '15s'`);
    await client.query(flowLedgerSql, [since, flowKinds]);
    const started = performance.now();
    const result = await client.query(flowLedgerSql, [since, flowKinds]);
    const ms = performance.now() - started;
    assert.ok(ms < 3000, `the ledger read took ${Math.round(ms)} ms`);
    assert.deepEqual(plain(result.rows), previous);
  } finally { client.release(); }
});

test('e2e:flow-ledger-fast — master status on the seeded install shows the flow numbers and no flow query over 3 s', { timeout: 600_000 }, async () => {
  forgetFlow(store);
  const directory = await temporaryDirectory('flow-ledger-fast');
  const config = masterConfigSchema.parse({ version: 1, url, repository: 'owner/project', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const root = await temporaryDirectory('flow-ledger-fast-root');
  execFileSync('git', ['init', '-q', root]);
  const masterApi = async (path: string) => {
    const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${coordinatorToken}` }, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(text), { status: response.status });
    return JSON.parse(text);
  };
  const status = await masterStatusReport(root, config, masterApi, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
  assert.ok(status.flow, `flow is shown (${status.flowError})`);
  for (const sql of [flowAttemptsSql, flowLedgerSql]) {
    const slow = await masterApi(`slowest-query?name=${encodeURIComponent(queryName(sql).slice(0, 60))}`);
    assert.equal(slow.slowest, null, `a flow query over 3 s: ${JSON.stringify(slow.slowest)}`);
  }
  const slowest = await masterApi('slowest-query');
  assert.ok(!String(slowest.slowest?.caller ?? '').includes('/api/flow'), `a /api/flow query over 3 s: ${JSON.stringify(slowest.slowest)}`);
});
