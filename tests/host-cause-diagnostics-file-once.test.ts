// Bound proof for GY-4121 AC-4: when several scheduled-diagnostics or trial failures share one
// host cause (for example npm EAI_AGAIN getaddrinfo for the registry, a missing tool, permission
// denied), the loop files one item naming the cause and the cases it hit, with next: operator,
// never one item per case, and never dispatches it to a worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, runDiagnostics, runGate, type GatePorts } from '../src/batch-gate.js';
import { fileFlakyCheck, fileLoopFault, gateFiledItem, type FaultItem } from '../src/daemon/control-plane.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import type { Work } from '../src/model.js';
import { workFixture } from './helpers/work-fixture.js';

const asWork = (item: FaultItem, key: string, ready = false): Work => workFixture({
  id: `work-${key}`, key, title: item.title, description: item.description, type: item.type, priority: item.priority,
  faultKey: item.faultKey, criteria: item.criteria, stage: 'backlog', ready, revision: 1, epoch: 0,
  createdAt: '2026-11-28T11:30:00.000Z', updatedAt: '2026-11-28T11:30:00.000Z', stageEnteredAt: '2026-11-28T11:30:00.000Z',
} as never) as Work;

test('integration:host-cause-diagnostics-file-once — six diagnostic cases failing on one EAI_AGAIN line file one item naming the cause and cases with next: operator and never dispatch to a worker', async () => {
  const cases = ['e2e:case-1', 'e2e:case-2', 'e2e:case-3', 'e2e:case-4', 'e2e:case-5', 'e2e:case-6'];
  const eaiLine = 'npm error request to https://registry.npmjs.org/tsx failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org';
  const record = bootstrapGate('cryptob1/huck', 'a'.repeat(40));
  const now = Date.parse('2026-11-28T11:31:00.000Z');

  const created: { item: FaultItem; idempotencyKey: string }[] = [];
  const work: Work[] = [];
  const notes: { key: string; text: string }[] = [];
  const file: GatePorts['file'] = async ({ refile, ...input }) => {
    const result = await fileLoopFault(
      {
        work, now,
        createWork: async (item, idempotencyKey) => {
          const key = `GY-${173 + created.length}`;
          created.push({ item, idempotencyKey });
          work.push(asWork(item, key));
          return { key };
        },
        note: async (existing, text) => { notes.push({ key: existing.key, text }); },
      },
      gateFiledItem(input, 'main', 'cryptob1/huck'),
      input.description,
      refile ? `${input.key}:${refile}` : input.key,
      !!refile,
    );
    return { item: result.action === 'unwired' ? null : result.item };
  };

  const failed = await runDiagnostics({
    now: () => now,
    file,
    faultDedup: () => true,
    open: () => true,
    diagnose: async () => ({
      failed: cases,
      catalogMs: 5_000,
      details: Object.fromEntries(cases.map(check => [check, eaiLine])),
      outputs: Object.fromEntries(cases.map(check => [check, [eaiLine]])),
    }),
  }, record);

  assert.deepEqual(failed, cases);
  assert.equal(created.length, 1, 'six cases sharing one EAI_AGAIN host cause must file one item, never six');
  const filed = created[0]!.item;
  assert.match(filed.faultKey, /^host-cause:/);
  assert.match(filed.title, /network unreachable to registry\.npmjs\.org/i);
  assert.match(filed.description, /^next: operator\b/m);
  for (const check of cases) assert.ok(filed.description.includes(check), `filed item must name hit case ${check}`);

  // Even if marked ready, the item must never be dispatched to a worker.
  const readyWork = asWork(filed, 'GY-173', true);
  assert.throws(() => assertDispatchable(readyWork, [readyWork], new Date(now).toISOString()), /next: operator|host fault/i);
});

test('integration:host-cause-diagnostics-file-once — trial failures sharing one missing-tool or permission-denied host cause file once with next: operator', async () => {
  const now = Date.parse('2026-11-28T11:35:00.000Z');
  const created: FaultItem[] = [];
  const work: Work[] = [];
  const notes: string[] = [];
  const reads = {
    baseBranch: 'main',
    now: () => now,
    createWork: async (item: FaultItem) => {
      const key = `GY-${200 + created.length}`;
      created.push(item);
      work.push(asWork(item, key));
      return { key };
    },
    note: async (_item: Pick<Work, 'id' | 'key'>, text: string) => { notes.push(text); },
  };

  // Three trial flake filings hitting the same missing tool collapse into one host-cause item.
  for (const check of ['test:tests/a.test.ts', 'test:tests/b.test.ts', 'test:tests/c.test.ts']) {
    await fileFlakyCheck(reads, 'cryptob1/huck', work, check, 'Failed to start: spawn docker ENOENT');
  }
  assert.equal(created.length, 1, 'three trial failures on one missing tool file one item');
  assert.equal(notes.length, 2, 'subsequent hits note the existing host-cause item');
  assert.match(created[0]!.description, /^next: operator\b/m);
  assert.throws(() => assertDispatchable(asWork(created[0]!, 'GY-200', true), [asWork(created[0]!, 'GY-200', true)], new Date(now).toISOString()), /next: operator|host fault/i);

  // Batch-gate known-red failures sharing one permission-denied cause also collapse into one host-cause item.
  const record = bootstrapGate('cryptob1/huck', 'b'.repeat(40));
  const gateCreated: { key: string; title: string; description: string }[] = [];
  const seen = { assertions: { 'tests/x.test.ts': "EACCES: permission denied, open '/srv/mainworks/token'", 'tests/y.test.ts': "EACCES: permission denied, open '/srv/mainworks/token'" }, flaked: new Set<string>() };
  await runGate({
    now: () => now,
    fetch: async () => 'c'.repeat(40),
    landings: async () => [],
    files: async () => ['src/foo.ts'],
    catalog: async () => [],
    core: async () => [],
    run: async (_commit, checks) => checks.includes('affected') ? ['test:tests/x.test.ts', 'test:tests/y.test.ts'] : [...checks],
    revert: async () => ({ held: 'unexpected' }),
    seen,
    file: async input => { gateCreated.push(input); return { item: `GY-${300 + gateCreated.length}` }; },
  }, record);
  assert.equal(gateCreated.length, 1, 'two known-red checks sharing one EACCES host cause file once');
  assert.match(gateCreated[0]!.key, /^host-cause:/);
  assert.match(gateCreated[0]!.description, /^next: operator\b/m);
  assert.ok(gateCreated[0]!.description.includes('test:tests/x.test.ts'));
  assert.ok(gateCreated[0]!.description.includes('test:tests/y.test.ts'));
});
