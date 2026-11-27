import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { recordMergeEvent } from '../src/server/merge-record.js';
import type { Services } from '../src/server/routes.js';
import type { GitRunner } from '../src/merge-writer/local-observation.js';
import { fixtureMergeSha } from './helpers/merge-ledger.js';
import { proveFixtureCase } from './helpers/ledger-delivery.js';
import { lifecycle } from './helpers/work-lifecycle.js';
import { itemObservation } from './helpers/observation-fixture.js';

// GY-3984: a trial that selected the whole suite ran over 1000 test files; its record was refused
// (too_big), retried and refused again forever. Such a merge is recorded and pushed like any other.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const writer: Principal = { id: 'merge-writer', role: 'coordinator', sessionKind: 'ai' };
const head = 'a'.repeat(40), base = 'b'.repeat(40);

let store: Store, engine: Engine;
before(async () => { store = await withDatabase('merge-record-many-files'); await store.init(); engine = new Engine(store, 120, 'owner/project'); engine.principals = [operator, worker, writer]; });
after(async () => { if (store) await store.close(); });

test('integration:merge-record-many-files — a trial record listing 1500 files is recorded, then pushed and reconciled', async () => {
  const created = await lifecycle(engine, operator, { type: 'chore', title: 'Many files', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:many', 'e2e:fixture'] }] }, { claim: worker, submit: {} });
  let work: Work = await engine.observe(created.id, created.revision, itemObservation(created, head, base, { source: 'control-plane', files: ['src/app.ts'], scopeFiles: [{ path: 'src/app.ts', status: 'modified', sha: null, additions: 1, deletions: 0, binary: false }] }));
  work = await proveFixtureCase(engine, work);
  const mergeSha = fixtureMergeSha(work), record = (body: unknown) => recordMergeEvent({ engine } as unknown as Services, writer, work.id, body, randomUUID());
  const files = Array.from({ length: 1500 }, (_, n) => `tests/case-${n}.test.ts`);
  await record({ kind: 'intent', head, baseTip: base, mergeSha, risk: 'normal', at: new Date().toISOString() });
  await record({ kind: 'trial', head, baseTip: base, mergeSha, outcome: 'verdict', build: 'pass', tests: { passed: 1500, failed: [], files: 1500 }, files, durationMs: 1, attempts: [],
    proofs: { 'unit:many': { executed: 1, failed: 0 }, 'e2e:fixture': { executed: 1, failed: 0 } } });
  assert.equal((await store.workItem(work.id))!.mergeLedger?.trial?.files?.length, 1500, 'the trial keeps every file it ran');
  await record({ kind: 'pushed', mergeSha, pushedAt: new Date().toISOString() });
  engine.gitRunner = (async () => ({ status: 0, stdout: '', stderr: '' })) as unknown as GitRunner;
  await record({ kind: 'reconciled', mergeSha, observedTip: mergeSha });
  const done = (await store.workItem(work.id))!;
  assert.equal(done.stage, 'done');
  assert.equal(done.delivery?.mergeSha, mergeSha);
});
