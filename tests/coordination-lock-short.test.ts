import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { advisoryLocks } from '../src/store/locks.js';
import { queryCaller } from '../src/store/slow-queries.js';
import { lockHoldAttention } from '../src/cli/master-status.js';
import type { Principal } from '../src/model.js';

// GY-3799: every coordination-lock hold is timed and master status names the longest of the last
// 10 minutes; the routes that held it for seconds (a preview's record on merge-record, an agent
// connect and its host key) no longer take it, so they answer while another transaction holds it.

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
const principals = [operator, coordinator];
const token = (p: Principal) => `${p.id}-${'t'.repeat(40)}`;

let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string, database: string;
before(async () => {
  database = await databaseUrl('coordination-lock-short');
  store = new Store(database); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.principals = principals;
  http = server(engine, principals.map(p => ({ ...p, token: token(p) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); if (store) await store.close(); });

const call = async (as: Principal, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token(as)}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};

test('integration:coordination-lock-short — a transaction holding the coordination lock 3 s is named, with its duration, as the longest hold in master status', async () => {
  await queryCaller.run('POST /api/seeded-hold as operator', () => store.transaction(db => db.query('SELECT pg_sleep(3)')));
  const { body } = await call(operator, 'GET', 'slowest-query');
  assert.equal(body.lockHold?.name, 'POST /api/seeded-hold as operator');
  assert.ok(body.lockHold.ms >= 3_000 && body.lockHold.ms < 4_000, `held ${body.lockHold.ms} ms`);
  const [line] = lockHoldAttention(body.lockHold, body.lockHold.at + 60_000);
  assert.match(line.text, /^The longest coordination-lock hold of the last 10 minutes was 3\.\d s, 1m ago, by POST \/api\/seeded-hold as operator$/);
});

test('integration:coordination-lock-short — a preview record, an agent connect and a host key answer in under 1 s while another transaction holds the coordination lock', async () => {
  const item = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Preview lock', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:fixture', 'e2e:coordination-lock-short'] }] }, randomUUID());
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const holder = new pg.Client({ connectionString: database });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.coordination]);
    const timed = async (name: string, run: () => Promise<{ status: number; body: unknown }>) => {
      const started = performance.now(), { status, body } = await run(), ms = performance.now() - started;
      assert.ok(status < 500, `${name}: ${status} ${JSON.stringify(body)}`);
      assert.ok(ms < 1_000, `${name} waited ${Math.round(ms)} ms behind the coordination lock`);
    };
    await timed('preview record', () => call(coordinator, 'POST', `work/${item.id}/merge-record`, { kind: 'preview', preview: {
      id: randomUUID(), path: `/preview/${item.key}`, state: 'starting', runner: 'local', application: 'site', sha: 'a'.repeat(40), source: 'base',
      origin: null, cases: [], detail: 'Starting', startedAt: new Date().toISOString(), readyAt: null, cleanedAt: null, endReason: null } }));
    await timed('host key registration', () => call(coordinator, 'POST', 'agent-registry/connect/host-key', { host: 'host-a', publicKey }));
    await timed('host key read', () => call(operator, 'GET', 'agent-registry/connect/host-key'));
    await timed('connect request', () => call(operator, 'POST', 'agent-registry/connect', { provider: 'claude', host: 'host-a', reason: 'More capacity' }));
    await timed('connect requests read', () => call(coordinator, 'GET', 'agent-registry/connect/requests?host=host-a'));
    await timed('connect list', () => call(operator, 'GET', 'agent-registry/connect'));
  } finally { await holder.query('ROLLBACK').catch(() => {}); await holder.end(); }
});

test('e2e:coordination-lock-short — on a running test install master status shows the longest coordination-lock hold', async () => {
  await queryCaller.run('POST /api/e2e-hold as operator', () => store.transaction(db => db.query('SELECT pg_sleep(1.5)')));
  const { body } = await call(operator, 'GET', 'slowest-query');
  const [line] = lockHoldAttention(body.lockHold, Date.now());
  assert.match(line?.text ?? '', /^The longest coordination-lock hold of the last 10 minutes was \d+\.\d s, .* ago, by /);
});
