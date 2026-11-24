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

// GY-3764: on the live install the flow's attempts read hit the 60 s statement timeout every minute:
// its "written to within the window" test was a subquery over every event id of the window, too many
// to hash, so it ran again for each item. The attempts and the time each item was last touched now
// live on the work index, and the read takes neither the events nor any whole document.
const adminToken = `operator-${'a'.repeat(32)}`;
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const ITEMS = 3500, ACTIVE = 1750, EVENTS = 2_000_000, ATTEMPTS = 60;
const flowKinds = ['rework', 'merge.intent', 'merge.trial', 'merge.refused', 'merge.serve-revert'];
let store: Store, http: ReturnType<typeof server>, url: string;
// The fixture's own statements run on a plain client, outside the timed pools, so the server's slowest-query report holds only what the server ran.
let fixture: pg.Client;

before(async () => {
  store = await withDatabase('flow-attempts-fast'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  http = server(engine, [{ id: 'operator', role: 'admin', sessionKind: 'human', token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const created = await fetch(`${url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ title: 'Template', why: 'Flow is measured.', simplest: 'Read it.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] }) });
  const { id } = await created.json() as { id: string };
  fixture = new pg.Client({ connectionString: (store.pool as unknown as { options: { connectionString: string } }).options.connectionString }); await fixture.connect();
  const template = (await fixture.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document;
  // Half the items worked on this week (open, attempts in the last 6 days); half settled a month ago with no event since. Each carries 60 attempts and a padded timeline.
  const attempts = (fromDays: string) => `(SELECT jsonb_agg(jsonb_build_object('epoch', a, 'owner', 'worker', 'claimedAt', to_char((now() - interval '${fromDays}' + make_interval(mins => a * 60)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'endedAt', CASE WHEN a < ${ATTEMPTS} THEN to_char((now() - interval '${fromDays}' + make_interval(mins => a * 60 + 30)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
      'end', CASE WHEN a < ${ATTEMPTS} THEN (ARRAY['submitted','released','expired'])[1 + a % 3] END, 'note', repeat(md5(a::text), 4)) ORDER BY a) FROM generate_series(1, ${ATTEMPTS}) a)`;
  const timeline = `(SELECT jsonb_agg(jsonb_build_object('at', n, 'text', repeat(md5((n * g.n)::text), 8))) FROM generate_series(1, 200) n)`;
  await fixture.query(`INSERT INTO work_items(id, document) SELECT g.id, $1::jsonb || jsonb_build_object('id', g.id::text, 'key', 'GY-' || (g.n + 100), 'timeline', ${timeline}) || CASE WHEN g.n <= ${ACTIVE}
      THEN jsonb_build_object('stage', 'build', 'stageEnteredAt', to_char((now() - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'pipeline', jsonb_build_object('attempts', ${attempts('6 days')}))
      ELSE jsonb_build_object('stage', 'done', 'stageEnteredAt', to_char((now() - interval '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'nextAction', null, 'queue', null, 'lease', null,
        'actionQueue', jsonb_build_object('actions', '[]'::jsonb), 'sessions', '[]'::jsonb,
        'delivery', jsonb_build_object('mergedAt', to_char((now() - interval '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'mergeSha', repeat('a', 40), 'authorizationRevision', 1),
        'pipeline', jsonb_build_object('attempts', ${attempts('40 days')})) END
    FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, ${ITEMS}) n) g`, [template]);
  await fixture.query('ALTER TABLE events SET UNLOGGED');
  // Two million events over the last 7 days, all on the items worked on this week: as on the live ledger, most are heartbeats and observations, one in seventeen a flow kind.
  await fixture.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
    SELECT ids[1 + d % array_length(ids, 1)], 'fixture', CASE d % 50 WHEN 0 THEN 'merge.trial' WHEN 1 THEN 'rework' WHEN 2 THEN 'merge.intent' ELSE (ARRAY['heartbeat','github.observed'])[1 + d % 2] END,
      jsonb_build_object('head', md5(d::text), 'durationMs', 600000), now() - interval '7 days' + interval '1 minute' + make_interval(secs => d * (7 * 86400 - 120)::float8 / ${EVENTS})
    FROM (SELECT array_agg(i.id) AS ids FROM work_index i WHERE NOT i.settled) i, generate_series(1, ${EVENTS}) d`);
  await fixture.query('VACUUM ANALYZE events'); await fixture.query('ANALYZE work_items'); await fixture.query('ANALYZE work_index');
  // GY-3795: warm the ledger scan on the plain client so e2e:flow-attempts-fast does not pay a cold 2M-row read on the timed pool.
  await fixture.query(flowLedgerSql, [new Date(Date.now() - 7 * 86_400_000), flowKinds]);
});

after(async () => {
  http?.closeAllConnections(); if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await fixture?.end(); await store?.close();
});

const trimmed = (list: any) => Array.isArray(list) ? list.map((a: any) => ({ claimedAt: a.claimedAt ?? null, endedAt: a.endedAt ?? null, end: a.end ?? null })) : null;

test('integration:flow-attempts-fast — on two million events over 7 days and 3,500 items with 60 attempts each, the attempts read answers in under 3 s with the same attempts as before', { timeout: 900_000 }, async () => {
  assert.ok(Number((await fixture.query('SELECT count(*) FROM events WHERE created_at > now() - interval \'7 days\'')).rows[0].count) >= EVENTS);
  assert.equal(Number((await fixture.query('SELECT count(*) FROM work_items')).rows[0].count), ITEMS + 1);
  const since = new Date(Date.now() - 7 * 86_400_000);

  // Before: every open item, every item merged in the window and every item with an event in the window, with its document's attempts.
  const before = new Map<string, any>((await fixture.query(`WITH touched AS MATERIALIZED (SELECT DISTINCT work_id FROM events WHERE created_at > $1 AND work_id IS NOT NULL)
    SELECT w.id, w.document->'pipeline'->'attempts' AS attempts FROM work_items w JOIN work_index i ON i.id = w.id LEFT JOIN touched t ON t.work_id = w.id
    WHERE NOT i.settled OR i.merged_at > $1 OR t.work_id IS NOT NULL`, [since])).rows.map(row => [row.id, trimmed(row.attempts)]));
  assert.equal(before.size, ACTIVE + 1, 'the week\'s items and the template');

  // GY-3795: on the plain client, so the cold first read, which may pass 3 s under load, never enters the server's slowest-query report the e2e test reads.
  await fixture.query(`SET statement_timeout = '15s'`);
  try {
    await fixture.query(flowAttemptsSql, [since]);
    const started = performance.now();
    const result = await fixture.query(flowAttemptsSql, [since]);
    const ms = performance.now() - started;
    assert.ok(ms < 3000, `the attempts read took ${Math.round(ms)} ms`);
    const after = new Map<string, any>(result.rows.map(row => [row.id, trimmed(row.attempts)]));
    for (const [id, attempts] of before) assert.deepEqual(after.get(id) ?? null, attempts, `item ${id}`);
    assert.equal(after.get([...before.keys()][0])?.length, ATTEMPTS);
  } finally { await fixture.query('RESET statement_timeout'); }
});

test('e2e:flow-attempts-fast — master status on the seeded install shows the flow numbers and no flow query over 3 s', { timeout: 600_000 }, async () => {
  forgetFlow(store);
  const directory = await temporaryDirectory('flow-attempts-fast');
  const config = masterConfigSchema.parse({ version: 1, url, repository: 'owner/project', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const root = await temporaryDirectory('flow-attempts-fast-root');
  execFileSync('git', ['init', '-q', root]);
  const masterApi = async (path: string) => {
    const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${coordinatorToken}` }, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(text), { status: response.status });
    return JSON.parse(text);
  };
  const status = await masterStatusReport(root, config, masterApi, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
  assert.ok(status.flow, `flow is shown (${status.flowError})`);
  assert.ok(status.flow['7d'].attempts > 0, 'the week\'s attempts are counted');
  // Every statement /api/flow ran, by name and by caller: the fixture's statements are not timed, so nothing hides a slow flow query.
  for (const sql of [flowAttemptsSql, flowLedgerSql]) {
    const slow = await masterApi(`slowest-query?name=${encodeURIComponent(queryName(sql).slice(0, 60))}`);
    assert.equal(slow.slowest, null, `a flow query over 3 s: ${JSON.stringify(slow.slowest)}`);
  }
  const slowest = await masterApi('slowest-query');
  assert.ok(!String(slowest.slowest?.caller ?? '').includes('/api/flow'), `a /api/flow query over 3 s: ${JSON.stringify(slowest.slowest)}`);
});
