import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { expireEvents, expiringKinds, ledgerCompactedKind } from '../src/store/compaction.js';

/**
 * GY-4005: core's events table reached 9.4 GB of a 10 GB database. The registry kinds nothing reads
 * past a day (observations and session ends, each once carrying the whole registry document) go
 * after a week, in small batches; an item's history never does.
 */
const named = ['agent-registry.observed', 'agent-registry.session-ended', 'agent-registry.sessions-settled'];

/** Every SQL text in src that reads the events table: each template literal holding `FROM events`. */
function eventReads() {
  const reads: { file: string; sql: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.ts')) for (const literal of readFileSync(path, 'utf8').match(/`[^`]*`/g) ?? []) if (/FROM events\b/.test(literal)) reads.push({ file: path, sql: literal });
    }
  };
  walk('src');
  return reads;
}

test('unit:event-retention-touches-only-unread-kinds — the retention names exactly the registry kinds no src read looks at past a day', () => {
  assert.deepEqual([...expiringKinds], named, 'every kind the retention may touch, by name');
  const reads = eventReads();
  assert.ok(reads.length > 20, 'the scan finds the ledger reads');
  for (const kind of named) {
    const suffix = kind.slice('agent-registry.'.length);
    // No read selects one of these kinds by name, whatever its window.
    const byName = reads.filter(read => read.sql.includes(kind) || read.sql.includes(`\${registryEventPrefix}${suffix}`));
    assert.deepEqual(byName.map(read => read.file), [], `${kind} is read by name`);
  }
  // The reads of the whole registry family are its newest rows (the history page, a pre-GY-4005 document), never a window reaching back.
  const family = reads.filter(read => /registryEventPrefix|'agent-registry/.test(read.sql) && /unownedFamilySql\(registryEventPrefix|split_part\(kind|LIKE 'agent-registry/.test(read.sql));
  assert.equal(family.length, 2, 'the history page and the pre-GY-4005 document read');
  for (const read of family) {
    assert.match(read.sql, /ORDER BY (e\.)?seq DESC LIMIT/, `${read.file} reads the newest rows`);
    assert.doesNotMatch(read.sql, /created_at\s*[<>]|interval/, `${read.file} reads no window`);
  }
});

test('integration:event-retention-keeps-item-history — on a seeded ledger the retention removes only the named kinds and only rows past the window, in small audited batches, and the table shrinks', async t => {
  const store = await withDatabase('event-retention');
  t.after(() => store.close());
  await store.init();
  const work = randomUUID();
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1, $2)', [work, JSON.stringify({ id: work, key: 'GY-1', stage: 'build' })]);
  const seed = (kind: string, rows: number, daysAgo: number, item: string | null = null) => store.pool.query(`INSERT INTO events(work_id, actor, kind, payload, created_at)
    SELECT $1, 'fixture', $2, jsonb_build_object('change', jsonb_build_object('n', g), 'pad', repeat('x', 300)), now() - ($3::text || ' days')::interval FROM generate_series(1, $4) g`, [item, kind, String(daysAgo), rows]);
  // 135,000 rows (GY-3792 caps a seed at 200,000): the named kinds past and inside the window,
  // an item's history past the window, and install-wide kinds the retention does not name.
  for (const kind of named) { await seed(kind, 20_000, 8); await seed(kind, 10_000, 2); }
  const history = ['stage', 'review.verdict.recorded', 'merge.pushed', 'heartbeat', 'claim', 'receipt'];
  for (const kind of history) await seed(kind, 5_000, 30, work);
  await seed('agent-registry.selected', 10_000, 30); await seed('agent-registry.refused', 5_000, 30);
  const counts = async () => Object.fromEntries((await store.pool.query(`SELECT kind, count(*)::int AS n FROM events WHERE kind <> '${ledgerCompactedKind}' GROUP BY kind`)).rows.map(row => [row.kind, row.n]));
  const size = async () => Number((await store.pool.query("SELECT pg_total_relation_size('events') AS bytes")).rows[0].bytes);
  const before = await counts(), sizeBefore = await size();

  // The 60,000 rows free about 20 MB here; core's whole-document rows free gigabytes against the 1 GB default.
  const result = await expireEvents(store.pool, { batches: 1_000, pauseMs: 0, rewriteAfterBytes: 10e6 });
  assert.equal(result.total, 60_000);
  assert.deepEqual(result.removed, Object.fromEntries(named.map(kind => [kind, 20_000])));
  assert.equal(result.done, true);
  const after = await counts();
  for (const kind of named) assert.equal(after[kind], 10_000, `${kind} keeps every row inside the window`);
  for (const kind of [...history, 'agent-registry.selected', 'agent-registry.refused']) assert.equal(after[kind], before[kind], `${kind} is untouched`);
  const audits = (await store.pool.query('SELECT payload FROM events WHERE kind=$1', [ledgerCompactedKind])).rows.map(row => row.payload.details.total as number);
  assert.equal(audits.reduce((sum, n) => sum + n, 0), 60_000, 'every removal is audited');
  assert.ok(audits.every(n => n <= 1_000), 'each batch removes at most 1,000 rows');
  assert.equal(result.rewritten, true, 'a catch-up this large rewrites the table');
  assert.ok(await size() < sizeBefore, 'the events table is smaller than before');

  const again = await expireEvents(store.pool, { pauseMs: 0, rewriteAfterBytes: 10e6 });
  assert.deepEqual([again.total, again.rewritten], [0, false], 'a pass with nothing past the window removes and rewrites nothing');
});
