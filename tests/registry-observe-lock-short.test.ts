import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { advisoryLocks } from '../src/store/locks.js';
import { lockHoldAttention } from '../src/cli/master-status.js';
import { proposedRuntimes, type AgentRegistry as Registry } from '../src/model/registry.js';
import type { Principal } from '../src/model.js';
import { listen } from './helpers/http-server.js';

// GY-3807: recording agent-registry observations writes in one batched statement and never holds
// the coordination lock, so coordinated writes never wait behind it and master status names no
// observe request among coordination-lock holds over 1 s.

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const principals = [operator, coordinator];
const token = (p: Principal) => `${p.id}-${'t'.repeat(40)}`;
const HOST = 'host-a';
const ACCOUNT_COUNT = 20;
const SESSION_COUNT = 50;

let store: Store, engine: Engine, close: (() => Promise<void>) | undefined, url: string, database: string;

const call = async (as: Principal, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token(as)}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};

const accountNames = Array.from({ length: ACCOUNT_COUNT }, (_, i) => `claude-${i + 1}`);
const allObservations = (percent: number, now = Date.now()) => {
  const resetsAt = new Date(now + 4 * 3_600_000).toISOString();
  const since = new Date(now).toISOString();
  return {
    host: HOST,
    observations: accountNames.map(account => ({
      account,
      quota: {
        loggedIn: true,
        state: 'available' as const,
        usage: [{ window: 'five_hour', percent, resetsAt }],
        resetsAt: null,
        reason: null,
        since,
      },
    })),
  };
};

before(async () => {
  database = await databaseUrl('registry-observe-lock-short');
  store = new Store(database); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = principals;
  ({ url, close } = await listen(server(engine, principals.map(p => ({ ...p, token: token(p) })))));

  // Seed 20 accounts and 50 live sessions on the test install.
  const claude = proposedRuntimes.find(runtime => runtime.name === 'claude')!;
  const applied = await call(operator, 'POST', 'agent-registry/apply', {
    runtimes: [claude],
    models: [{ name: 'opus', id: 'claude-opus-4-6' }],
    accounts: accountNames.map(name => ({
      name,
      runtime: claude.name,
      model: 'opus',
      credential: { host: HOST, home: `/srv/accounts/${name}` },
      enabled: true,
      maxSessions: 3,
    })),
    roles: [{ name: 'worker', accounts: accountNames, concurrency: 3 }],
    reason: 'Seed 20 accounts for GY-3807',
  });
  assert.equal(applied.status, 200, `apply: ${JSON.stringify(applied.body)}`);

  for (let i = 1; i <= SESSION_COUNT; i++) {
    const selected = await call(coordinator, 'POST', 'agent-registry/select', {
      role: 'worker',
      host: HOST,
      work: `GY-${i}`,
      principal: `worker-${i}`,
      observations: [],
    });
    assert.equal(selected.status, 200, `select ${i}: ${JSON.stringify(selected.body)}`);
    assert.equal(selected.body.selected, true, `select ${i} refused: ${selected.body.reason}`);
  }

  const doc = (await call(operator, 'GET', 'agent-registry/document')).body as Registry;
  assert.equal(doc.accounts.length, ACCOUNT_COUNT);
  assert.equal(doc.sessions.length, SESSION_COUNT);
});

after(async () => { await close?.(); if (store) await store.close(); });

test('integration:registry-observe-lock-short — an observe request carrying every account answers in under 1 s without holding the coordination lock on a seeded install with 20 accounts and 50 sessions', async () => {
  const holder = new pg.Client({ connectionString: database });
  await holder.connect();
  let timer: NodeJS.Timeout | undefined;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await holder.query('ROLLBACK').catch(() => {});
  };
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.coordination]);
    // Release after 1.5 s so a buggy implementation that waits on the coordination lock finishes
    // and fails the < 1 s assertion promptly rather than hanging until timeout.
    timer = setTimeout(() => { void release(); }, 1_500);

    const started = performance.now();
    const { status, body } = await call(coordinator, 'POST', 'agent-registry/observe', allObservations(15));
    const ms = performance.now() - started;

    assert.equal(status, 200, `observe: ${status} ${JSON.stringify(body)}`);
    assert.equal(body.changed, true);
    assert.ok(ms < 1_000, `POST /api/agent-registry/observe waited ${Math.round(ms)} ms behind the coordination lock`);

    const doc = (await call(operator, 'GET', 'agent-registry/document')).body as Registry;
    assert.equal(doc.accounts.filter(account => account.quota.state === 'available' && account.quota.usage[0]?.percent === 15).length, ACCOUNT_COUNT);
  } finally {
    if (timer) clearTimeout(timer);
    await release();
    await holder.end();
  }
});

test('e2e:registry-observe-lock-short — on a running test install master status names no observe request among coordination-lock holds over 1 s', async () => {
  const { status, body } = await call(coordinator, 'POST', 'agent-registry/observe', allObservations(25, Date.now() + 1_000));
  assert.equal(status, 200, `observe: ${status} ${JSON.stringify(body)}`);
  assert.equal(body.changed, true);

  const slowest = await call(operator, 'GET', 'slowest-query');
  assert.equal(slowest.status, 200);
  const hold = slowest.body.lockHold;
  assert.ok(!hold?.name?.includes('agent-registry/observe'), `master status named observe as a coordination-lock hold: ${JSON.stringify(hold)}`);
  const lines = lockHoldAttention(hold, Date.now());
  assert.ok(lines.every(line => !line.text.includes('agent-registry/observe')), `unexpected lock-hold attention: ${JSON.stringify(lines)}`);
});
