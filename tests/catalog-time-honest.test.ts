import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapGate, catalogFits, gateLimitMs, gateRecordPath, measuredCatalogMs, readGateRecord, runDiagnostics, runGate, writeGateRecord, type GatePorts } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { TrialTimeoutError } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

const start = Date.parse('2030-01-01T00:00:00Z'), elapsed = 90 * 60_000, short = 464_165;
const repository = 'owner/project', verified = 'a'.repeat(40), tip = 'b'.repeat(40);

for (const failure of ['e2e-catalog', 'e2e:broken']) test(`integration:catalog-time-honest — diagnostics ${failure} cannot replace a slow measurement with a partial time`, async () => {
  let clock = start;
  const record = { ...bootstrapGate(repository, verified), catalogMs: elapsed };
  await runDiagnostics({ now: () => clock, file: async () => ({ item: null }), diagnose: async () => {
    clock += elapsed;
    return { failed: [failure], catalogMs: short };
  } }, record);
  assert.ok(record.catalogMs >= elapsed, 'a failed or timed-out diagnostic keeps its prior measurement or records at least elapsed time');
  assert.equal(catalogFits(record, clock), false);
});

test('integration:catalog-time-honest — a whole-catalog trial timeout is measured and the retry runs the subset', async () => {
  let clock = start, calls = 0;
  const record = { ...bootstrapGate(repository, verified), catalogMs: short };
  const selections: string[][] = [];
  const ports: GatePorts = {
    now: () => clock, fetch: async () => tip, landings: async () => [], files: async () => ['app.ts'],
    catalog: async () => ['smoke', 'unrelated'], core: async () => [], file: async () => ({ item: null }),
    revert: async () => { throw new Error('unused'); },
    run: async (_commit, checks) => {
      selections.push([...checks]);
      if (++calls === 1) { clock += gateLimitMs; throw new TrialTimeoutError('tests', gateLimitMs, 'catalog timed out'); }
      return [];
    },
  };
  assert.equal((await runGate(ports, record)).outcome, 'timeout');
  assert.ok(measuredCatalogMs(record, clock)! >= gateLimitMs);
  assert.equal(catalogFits(record, clock), false);
  assert.equal((await runGate(ports, record)).outcome, 'verified');
  assert.ok(selections[0]!.includes('e2e:unrelated'));
  assert.deepEqual(selections[1], ['build', 'affected']);
});

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

test('e2e:catalog-time-honest — a test install persists a catalog timeout and verifies its next release check with the affected subset', async () => {
  const base = await temporaryDirectory('catalog-time-honest');
  const { root: checkout, head: before } = await gitRepo({ root: join(base, 'install'), origin: true, files: { 'graphyard.json': '{}',
    ...Object.fromEntries(['smoke', 'unrelated'].map(id => [`e2e/cases/${id}.json`, JSON.stringify({ id, steps: [] })])) } });
  await writeFile(join(checkout, 'app.ts'), 'export const works = true;\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'change'); git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  const head = git(checkout, 'rev-parse', 'HEAD'), file = gateRecordPath(checkout);
  await writeGateRecord(file, { ...bootstrapGate(repository, before), catalogMs: short, diagnosticsAt: new Date(start).toISOString() });
  let clock = start;
  const selections: string[][] = [];
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock, fetch: async () => head,
    git: async (args, extra) => execFileSync('git', ['-C', checkout, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }),
    trial: async (_commit, files, item) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      selections.push(proofs);
      assert.deepEqual(files, ['app.ts'], 'the release check keeps affected test selection');
      if (selections.length === 1) { clock += gateLimitMs; throw new TrialTimeoutError('tests', gateLimitMs, 'catalog timed out'); }
      const persisted = readGateRecord(file)!;
      assert.equal(catalogFits(persisted, clock), false, 'the timeout is persisted before retrying');
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
    },
    merge: async () => { throw new Error('unused'); }, push: async () => 'pushed', holds: async () => true, record: async () => {},
    gate: { root: checkout, repository },
  };
  const cycle = { state: emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as never), effects: { mergeWriter: reads } as never,
    snapshot: { work: [], now: new Date(clock).toISOString() } as never, performed: [], now: () => clock, log: () => {} };
  const step = await batchGateStep(cycle);
  await step!.gate; await step!.diagnostics;
  assert.deepEqual(selections, [['e2e:smoke', 'e2e:unrelated', 'e2e:graphyard-feature-map'], ['e2e:graphyard-feature-map']]);
  const record = readGateRecord(file)!;
  assert.equal(record.verified, head);
  assert.equal(record.lastOutcome?.outcome, 'verified');
  assert.ok(measuredCatalogMs(record, clock)! >= gateLimitMs);
});
