import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';

// GY-3677: /api/status answers without reading the flow numbers; /api/flow still serves them.
const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(32)}`;
let store: Store, http: ReturnType<typeof server>, url: string;

before(async () => {
  store = await withDatabase('status-without-flow'); await store.init();
  http = server(new Engine(store, 120, 'owner/game'), [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
});

const get = async (path: string) => {
  const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, path);
  return response.json() as Promise<any>;
};

test('integration:status-without-flow — /api/status runs no flow query and carries no flow; /api/flow returns the numbers', async () => {
  // The flow read's own queries: the ledger rows by event kind and each item's attempts.
  const flowSql = (text: string) => /merge\.serve-revert|'pipeline'->'attempts'/.test(text) || /payload \? 'work'/.test(text);
  const seen: string[] = [];
  const query = store.pool.query.bind(store.pool);
  (store.pool as any).query = (text: any, ...rest: any[]) => { seen.push(typeof text === 'string' ? text : text?.text ?? ''); return (query as any)(text, ...rest); };
  try {
    // The installer's status check waits 30 s for a fresh install's authenticated /api/status.
    const started = Date.now();
    const status = await get('status');
    assert.ok(Date.now() - started < 30_000, 'GET /api/status answers within the 30 s check');
    assert.equal('flow' in status, false);
    assert.deepEqual(seen.filter(flowSql), []);
    seen.length = 0;
    const flow = await get('flow');
    assert.deepEqual(Object.keys(flow).filter(key => key !== 'attention').sort(), ['24h', '6h', '7d']);
    assert.equal(typeof flow['24h'].attemptsPerHour, 'number');
    assert.ok(seen.some(flowSql), 'GET /api/flow reads the ledger');
  } finally {
    (store.pool as any).query = query;
  }
});
