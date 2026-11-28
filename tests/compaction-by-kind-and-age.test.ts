import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { resolvedPayloadSql } from '../src/store.js';
import { batchLookupSql, compactLedger, ledgerCompactedKind } from '../src/store/compaction.js';
import type { Work } from '../src/model.js';

/**
 * GY-4132: ledger compaction deletes expired rows of every compactable kind by kind and age,
 * regardless of where any saved cursor stands, using the (kind, created_at) index, and moves
 * delta bases forward when deleting expired whole saves so surviving items resolve identically.
 */
test('integration:compaction-deletes-expired-rows-behind-the-cursor — expired compactable rows placed before a saved compaction cursor are deleted in short indexed batches while history kinds remain', async t => {
  const store = await withDatabase('compaction-behind-cursor');
  t.after(() => store.close());
  await store.init();

  const id = randomUUID();
  const now = new Date().toISOString();
  const doc = {
    id, key: 'GY-BC1', title: 'Behind cursor', type: 'feature', priority: 2, stage: 'build',
    ready: true, revision: 1, createdAt: now, updatedAt: now, epoch: 1, lease: null,
    submission: null, workspaces: [], dependencies: [], evidence: [], criteria: [],
    actionQueue: { actions: [] }, gates: [],
  };
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1,$2)', [id, JSON.stringify(doc)]);
  const baseSeq = Number((await store.pool.query(
    `INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES($1,'fixture','create',$2, now() - interval '30 days') RETURNING seq`,
    [id, JSON.stringify({ work: doc })],
  )).rows[0].seq);

  // Seed 50,000 rows (well under 200,000): expired github.observed, heartbeat and reconciled rows
  // plus item-history rows placed BEFORE the saved cursor, followed by recent rows.
  const seedDeltas = (kind: string, count: number, daysAgo: number, revOffset: number) => store.pool.query(
    `INSERT INTO events(work_id, actor, kind, payload, created_at)
     SELECT $1, 'fixture', $2,
       jsonb_build_object('stage', 'build', 'delta', jsonb_build_object('base', $3::bigint, 'revision', $4::int + g, 'updatedAt', $5::text, 'lease', null, 'submission', null, 'ops', jsonb_build_array(jsonb_build_array(jsonb_build_array('revision'), $4::int + g)))),
       now() - ($6::text || ' days')::interval + g * interval '1 millisecond'
     FROM generate_series(1, $7::int) g`,
    [id, kind, baseSeq, revOffset, now, String(daysAgo), count],
  );

  await seedDeltas('github.observed', 20_000, 10, 10);
  await seedDeltas('heartbeat', 10_000, 10, 30_000);
  await seedDeltas('reconciled', 5_000, 20, 50_000);
  const historyKinds = ['stage', 'claim', 'review.verdict.recorded', 'merge.trial-step'] as const;
  for (const [i, kind] of historyKinds.entries()) {
    await store.pool.query(
      `INSERT INTO events(work_id, actor, kind, payload, created_at)
       SELECT $1, 'fixture', $2, jsonb_build_object('work', $3::jsonb), now() - interval '20 days' + g * interval '1 millisecond'
       FROM generate_series(1, 1000) g`,
      [id, kind, JSON.stringify({ ...doc, revision: 60_000 + i * 2000 })],
    );
  }
  // Place a saved compaction cursor AFTER all the old rows above.
  const cursorSeq = Number((await store.pool.query('SELECT max(seq) AS seq FROM events')).rows[0].seq);
  await store.pool.query('INSERT INTO ledger_compaction_cursor(id, seq) VALUES(true, $1) ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq', [cursorSeq]);

  // Add recent rows after the cursor (inside the 7-day retention window).
  await seedDeltas('github.observed', 6_000, 1, 80_000);
  await seedDeltas('heartbeat', 5_000, 1, 90_000);
  await store.pool.query('ANALYZE events');

  // Verify the batch lookup uses the (kind, created_at) index and never sequentially scans events.
  const plan = (await store.pool.query(
    `EXPLAIN ${batchLookupSql}`,
    ['github.observed', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), 2_000],
  )).rows.map(r => r['QUERY PLAN'] as string).join('\n');
  assert.doesNotMatch(plan, /Seq Scan on events/, `batch lookup must not sequentially scan events:\n${plan}`);
  assert.match(plan, /events_kind_created/, `batch lookup must use events_kind_created:\n${plan}`);

  // Verify the events trigger still refuses deleting item-history kinds inside compaction.
  const db = await store.pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL graphyard.ledger_compaction = 'on'");
    await assert.rejects(db.query("DELETE FROM events WHERE work_id=$1 AND kind='stage'", [id]), /append-only/);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }

  // Run compaction passes until settled (should finish in 1 pass within the time budget).
  let totalRemoved = 0;
  for (let pass = 0; pass < 3; pass++) {
    const res = await compactLedger(store.pool, { pauseMs: 0 });
    totalRemoved += res.total;
    if (res.total === 0) break;
  }

  assert.equal(totalRemoved, 35_000, 'all 35,000 expired compactable rows behind the cursor are deleted');

  const counts = Object.fromEntries(
    (await store.pool.query(
      `SELECT kind || ':' || CASE WHEN created_at < now() - interval '7 days' THEN 'old' ELSE 'recent' END AS k, count(*)::int AS n
       FROM events WHERE work_id = $1 GROUP BY 1`,
      [id],
    )).rows.map(r => [r.k, r.n]),
  );
  assert.equal(counts['github.observed:old'], undefined, 'no expired github.observed rows remain');
  assert.equal(counts['heartbeat:old'], undefined, 'no expired heartbeat rows remain');
  assert.equal(counts['reconciled:old'], undefined, 'no expired reconciled rows remain');
  assert.equal(counts['github.observed:recent'], 6_000, 'recent github.observed rows remain');
  assert.equal(counts['heartbeat:recent'], 5_000, 'recent heartbeat rows remain');
  assert.equal(counts['create:old'], 1, 'create row remains');
  for (const kind of historyKinds) {
    assert.equal(counts[`${kind}:old`], 1_000, `history kind ${kind} remains untouched`);
  }

  // Audit rows recorded counts per kind totaling what was removed.
  const audits = (await store.pool.query('SELECT payload FROM events WHERE kind = $1', [ledgerCompactedKind])).rows.map(r => r.payload.details);
  assert.ok(audits.length >= 1, 'at least one ledger.compacted audit row is written');
  const auditedByKind: Record<string, number> = {};
  for (const audit of audits) {
    for (const [k, n] of Object.entries(audit.removed as Record<string, number>)) {
      auditedByKind[k] = (auditedByKind[k] ?? 0) + n;
    }
  }
  assert.deepEqual(auditedByKind, { 'github.observed': 20_000, heartbeat: 10_000, reconciled: 5_000 });
});

test('integration:compaction-removes-bounded-whole-saves — deleting expired whole github.observed and heartbeat saves moves delta bases forward so surviving rows and the item resolve identically', async t => {
  const store = await withDatabase('compaction-bounded-whole-saves');
  t.after(() => store.close());
  await store.init();

  const id = randomUUID();
  const now = new Date().toISOString();
  const work: any = {
    id, key: 'GY-WS1', title: 'Bounded whole saves', type: 'feature', priority: 2, stage: 'build',
    ready: true, revision: 1, createdAt: now, updatedAt: now, epoch: 1,
    lease: { epoch: 1, owner: 'worker-1', expiresAt: now },
    submission: null, workspaces: [], dependencies: [], evidence: [], criteria: [],
    actionQueue: { actions: [] }, gates: [], observation: { pass: 0 },
  };
  await store.pool.query('INSERT INTO work_items(id, document) VALUES($1,$2)', [id, JSON.stringify(work)]);

  const insertWhole = async (kind: string, daysAgo: number, mutate: () => void) => {
    work.revision++;
    mutate();
    const seq = Number((await store.pool.query(
      `INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES($1,'fixture',$2,$3, now() - ($4::text || ' days')::interval) RETURNING seq`,
      [id, kind, JSON.stringify({ work }), String(daysAgo)],
    )).rows[0].seq);
    return seq;
  };
  const insertDelta = async (kind: string, daysAgo: number, baseSeq: number, ops: unknown[], mutate: () => void, details?: unknown) => {
    work.revision++;
    mutate();
    const payload: any = {
      stage: work.stage,
      delta: { base: baseSeq, revision: work.revision, updatedAt: work.updatedAt, lease: work.lease, submission: work.submission, ops },
    };
    if (details !== undefined) payload.details = details;
    const seq = Number((await store.pool.query(
      `INSERT INTO events(work_id, actor, kind, payload, created_at) VALUES($1,'fixture',$2,$3, now() - ($4::text || ' days')::interval) RETURNING seq`,
      [id, kind, JSON.stringify(payload), String(daysAgo)],
    )).rows[0].seq);
    return seq;
  };

  // Seed:
  // 1. create (30d ago, whole)
  await insertWhole('create', 30, () => {});
  // 2. old github.observed (10d ago, whole) — later rows build on it!
  const oldGhWhole = await insertWhole('github.observed', 10, () => { work.observation = { pass: 1, pr: 42 }; });
  // 3. non-routine delta (blocked, 10d ago) built on oldGhWhole
  const blockedSeq = await insertDelta('blocked', 10, oldGhWhole, [[['revision'], work.revision + 1], [['blocker'], 'waiting']], () => { work.blocker = 'waiting'; }, { reason: 'waiting' });
  // 4. old heartbeat (10d ago, whole) — later recent rows build on it!
  const oldHbWhole = await insertWhole('heartbeat', 10, () => { work.lease = { epoch: 1, owner: 'worker-1', expiresAt: '2026-11-20T00:00:00.000Z' }; delete work.blocker; });
  // 5. recent heartbeat delta (1d ago) built on oldHbWhole
  const recentHb1 = await insertDelta('heartbeat', 1, oldHbWhole, [[['revision'], work.revision + 1], [['lease', 'expiresAt'], '2026-11-27T00:00:00.000Z']], () => { work.lease = { epoch: 1, owner: 'worker-1', expiresAt: '2026-11-27T00:00:00.000Z' }; });
  // 6. recent github.observed delta (0d ago, newest save) built on oldHbWhole
  const recentGh2 = await insertDelta('github.observed', 0, oldHbWhole, [[['revision'], work.revision + 1], [['lease', 'expiresAt'], '2026-11-28T00:00:00.000Z'], [['observation'], { pass: 2, pr: 42 }]], () => { work.lease = { epoch: 1, owner: 'worker-1', expiresAt: '2026-11-28T00:00:00.000Z' }; work.observation = { pass: 2, pr: 42 }; });

  await store.pool.query('UPDATE work_items SET document = $2 WHERE id = $1', [id, JSON.stringify(work)]);

  const resolvedBefore = new Map(
    (await store.pool.query(`SELECT seq, ${resolvedPayloadSql()} AS payload FROM events WHERE work_id = $1 ORDER BY seq`, [id]))
      .rows.map(r => [Number(r.seq), r.payload.work as Work]),
  );
  const newestBefore = (await store.events(id))[0].payload.work;
  assert.deepEqual(newestBefore, work);

  const result = await compactLedger(store.pool, { pauseMs: 0 });
  assert.ok(result.total >= 2, `compaction deleted the old whole saves (removed ${result.total})`);

  const remaining = (await store.pool.query('SELECT seq, kind, payload FROM events WHERE work_id = $1 ORDER BY seq', [id])).rows as { seq: string; kind: string; payload: any }[];
  const remainingSeqs = new Set(remaining.map(r => Number(r.seq)));
  assert.ok(!remainingSeqs.has(oldGhWhole), 'expired github.observed whole save is deleted');
  assert.ok(!remainingSeqs.has(oldHbWhole), 'expired heartbeat whole save is deleted');
  assert.ok(remainingSeqs.has(blockedSeq), 'non-routine blocked row survives');
  assert.ok(remainingSeqs.has(recentHb1), 'recent heartbeat row survives');
  assert.ok(remainingSeqs.has(recentGh2), 'newest github.observed row survives');

  // Every surviving delta's base still exists and is a whole row.
  for (const row of remaining) {
    if (row.payload.delta) {
      const base = remaining.find(r => Number(r.seq) === row.payload.delta.base);
      assert.ok(base?.payload.work, `delta at seq ${row.seq} points to a surviving whole base`);
    }
  }

  // Every surviving row and the item's resolved document are unchanged.
  const resolvedAfter = (await store.pool.query(`SELECT seq, ${resolvedPayloadSql()} AS payload FROM events WHERE work_id = $1 ORDER BY seq`, [id])).rows;
  for (const row of resolvedAfter) {
    assert.deepEqual(row.payload.work, resolvedBefore.get(Number(row.seq)), `surviving row ${row.seq} resolves identically`);
  }
  assert.deepEqual((await store.events(id))[0].payload.work, newestBefore, 'the item resolves to the exact same document');
  for (const seq of [blockedSeq, recentHb1, recentGh2]) {
    const expected = resolvedBefore.get(seq)!;
    const atRev = (await store.pool.query('SELECT graphyard_work_at_revision($1, $2) AS work', [id, String(expected.revision)])).rows[0].work;
    assert.deepEqual(atRev, expected, `revision ${expected.revision} still resolves identically via graphyard_work_at_revision`);
  }
});
