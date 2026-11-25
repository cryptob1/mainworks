import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { gateFiledItem } from '../src/daemon/control-plane.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3821: a Flaky check on main item the loop files tells its Builder how to pin the race
// through a test seam; Known red and Diagnostic failure items keep the existing AC-1 text.

const repository = 'cryptob1/graphyard';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const credentials = [{ ...operator, token: `flaky-pin-${operator.id}-${'x'.repeat(32)}` }];
const token = credentials[0]!.token;
const defaultAc1Text = 'The fault is fixed at its cause, not skipped or weakened; a new test pins it and fails without the fix';

let store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

const ok = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(parsed));
  return parsed;
};

const assertSeamGuidance = (text: string) => {
  assert.match(text, /reproduces the race/i);
  assert.match(text, /injecting the one condition the test waits on through a test seam/i);
  assert.match(text, /never by loading the host or lengthening a wait, timeout or poll bound/i);
  assert.match(text, /fails on the base tip on every run/i);
};

before(async () => {
  store = await withDatabase('flaky-item-pin-guidance');
  await store.init();
  engine = new Engine(store, 300, repository);
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { http?.close(); await store?.close(); });

test('integration:flaky-item-pin-guidance — Flaky check on main items carry test-seam pin guidance while Known red and Diagnostic failure items keep today\'s AC-1 text', async () => {
  const testFile = 'tests/example-race.test.ts';
  const flakyPayload = gateFiledItem({ key: `flake:test:${testFile}`, title: `Flaky check on main: test:${testFile}`, description: 'Flaked on main.' }, 'main', repository);
  const knownRedPayload = gateFiledItem({ key: `known-red:test:${testFile}`, title: `Known red on main: test:${testFile}`, description: 'Red on main.' }, 'main', repository);
  const diagnosticPayload = gateFiledItem({ key: `diagnostic:test:${testFile}`, title: `Diagnostic failure on main: test:${testFile}`, description: 'Diagnostic failed on main.' }, 'main', repository);

  const flaky = await ok('POST', 'work', flakyPayload) as Work;
  const knownRed = await ok('POST', 'work', knownRedPayload) as Work;
  const diagnostic = await ok('POST', 'work', diagnosticPayload) as Work;

  const flakyAc1 = flaky.criteria.find(c => c.id === 'AC-1')?.text ?? '';
  const knownRedAc1 = knownRed.criteria.find(c => c.id === 'AC-1')?.text ?? '';
  const diagnosticAc1 = diagnostic.criteria.find(c => c.id === 'AC-1')?.text ?? '';

  assertSeamGuidance(flakyAc1);
  assert.equal(knownRedAc1, defaultAc1Text, 'Known red item keeps today\'s AC-1 text');
  assert.equal(diagnosticAc1, defaultAc1Text, 'Diagnostic failure item keeps today\'s AC-1 text');
});

test('e2e:flaky-item-pin-guidance — on a running test install a filed flaky-check item shows the seam guidance in its criteria', { timeout: 280_000 }, async () => {
  const flakyTest = `const { test } = require('node:test');
const fs = require('fs');
test('tests/flaky.test.cjs passes unless broken', () => {
  const marker = fs.existsSync('broken') ? fs.readFileSync('broken', 'utf8').trim() : '';
  if (marker && !fs.existsSync(marker)) { fs.writeFileSync(marker, ''); throw new Error('flaked'); }
});
`;
  const where = await pipelineWorld('flaky-item-pin-guidance-e2e', {
    'package.json': JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs tests/flaky.test.cjs' } }),
    'tests/flaky.test.cjs': flakyTest,
  });
  try {
    const loop = worldLoop(where, { gate: false, attribute: true });
    const change = await where.submit('A change the flaky test fails once on', { broken: `${join(where.root, 'flaked-once')}\n` });
    await cycleUntil(loop, `${change.key} merges`, async () => (await where.work()).find(item => item.id === change.id)?.stage === 'done');
    const filed = (await where.work()).find(item => item.title === 'Flaky check on main: test:tests/flaky.test.cjs');
    assert.ok(filed, 'the flaky-check item was filed on the running test install');
    const ac1 = filed.criteria.find(c => c.id === 'AC-1')?.text ?? '';
    assertSeamGuidance(ac1);
  } finally {
    await where.close();
  }
});
