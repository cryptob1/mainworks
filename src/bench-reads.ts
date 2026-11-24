import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { workDocumentSql } from './store/bounded-snapshot.js';
import { eventHistorySql, parseEventHistoryQuery } from './events-history.js';
import { flowKinds, flowLedgerSql, readFlow } from './server/flow.js';
import { copyTemplateCluster, templateDatabase, warmPassword, warmUser } from './e2e/warm-postgres.js';
import { startCluster, type LocalPaths } from './install/local-runtime.js';
import { reserveTestPorts } from './cli/test-isolation.js';

/**
 * `bench reads` (GY-3792): the four large-ledger reads timed on two million seeded events, once,
 * outside trials and the release check. Tests prove their plans and rows on 50,000.
 */
export const benchReadEvents = 2_000_000;
export type BenchReads = { events: number; seedMs: number; reads: Record<'flowLedger' | 'flowComputation' | 'eventHistoryPage' | 'itemStatus', number> };

async function timed(read: () => Promise<unknown>) {
  await read();
  const started = performance.now();
  await read();
  return Math.round(performance.now() - started);
}

/** Seed `events` rows on a fresh database and time each read warm. */
export async function benchReads(connectionString: string, events = benchReadEvents): Promise<BenchReads> {
  const store = new Store(connectionString);
  try {
    await store.init();
    const started = performance.now();
    const key = 'GY-1';
    const id = (await store.pool.query(`INSERT INTO work_items(id, document) SELECT g.id, jsonb_build_object('id', g.id::text, 'key', 'GY-' || g.n, 'title', 'Item ' || g.n, 'stage', 'build')
      FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 2000) n) g RETURNING id`)).rows[0].id;
    await store.pool.query('ALTER TABLE events SET UNLOGGED');
    // Over the last 7 days: mostly heartbeats and observations, one in fifty a flow kind, one in forty a save with its document.
    await store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
      SELECT ids[1 + d % array_length(ids, 1)], 'bench', CASE WHEN d % 40 = 3 THEN 'work.saved' ELSE CASE d % 50 WHEN 0 THEN 'merge.trial' WHEN 1 THEN 'rework' WHEN 2 THEN 'merge.intent'
          ELSE (ARRAY['heartbeat','github.observed','reconciled'])[1 + d % 3] END END,
        CASE WHEN d % 40 = 3 THEN jsonb_build_object('work', jsonb_build_object('stage', (ARRAY['build','review','test','merge'])[1 + d % 4], 'pad', repeat(md5(d::text), 20)))
          ELSE jsonb_build_object('head', md5(d::text), 'durationMs', 600000) END,
        now() - interval '7 days' + interval '1 minute' + make_interval(secs => d * (7 * 86400 - 120)::float8 / $1)
      FROM (SELECT array_agg(id) AS ids FROM work_items) i, generate_series(1, $1::int) d`, [events]);
    await store.pool.query('ANALYZE');
    const seedMs = Math.round(performance.now() - started);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const work = await store.fleet();
    const page = eventHistorySql(parseEventHistoryQuery(new URLSearchParams({ work: id })));
    return { events, seedMs, reads: {
      flowLedger: await timed(() => store.pool.query(flowLedgerSql, [since, flowKinds])),
      flowComputation: await timed(() => readFlow(store.pool, work, Date.now())),
      eventHistoryPage: await timed(() => store.pool.query(page.text, page.values)),
      itemStatus: await timed(() => store.pool.query(workDocumentSql(key), [key])),
    } };
  } finally { await store.close(); }
}

/** The same on a scratch cluster that is removed afterwards. */
export async function benchReadsScratch(events = benchReadEvents): Promise<BenchReads> {
  const data = await mkdtemp(join(tmpdir(), 'mainworks-bench-reads-'));
  const ports = await reserveTestPorts();
  try {
    await copyTemplateCluster(data, ports.base);
    const cluster = await startCluster({ data } as LocalPaths, ports.base);
    try {
      return await benchReads(`postgres://${warmUser}:${warmPassword}@127.0.0.1:${ports.base}/${templateDatabase}`, events);
    } finally { await cluster.stop(); }
  } finally { ports.release(); await rm(data, { recursive: true, force: true }); }
}
