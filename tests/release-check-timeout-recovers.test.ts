import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { bootstrapGate, catalogFits, gateRecordPath, readGateRecord, runGate, writeGateRecord, type GatePorts } from '../src/batch-gate.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const start = Date.parse('2030-01-01T00:00:00Z'), short = 464_165;
const repository = 'owner/project', verified = 'a'.repeat(40), tip = 'b'.repeat(40);

test('integration:release-check-timeout-recovers — a prior whole-catalog timeout runs the affected subset even when the stored catalog time is short', async () => {
  const priorTimeout = { tip, outcome: 'timeout' as const, reason: 'past 45 minutes', finishedAt: new Date(start - 60_000).toISOString() };
  for (const seeded of [
    { ...bootstrapGate(repository, verified), catalogMs: short, attempt: { recuts: 0, timeouts: 1 }, lastOutcome: priorTimeout },
    { ...bootstrapGate(repository, verified), catalogMs: short, attempt: { recuts: 0, timeouts: 1 } },
    { ...bootstrapGate(repository, verified), catalogMs: short, lastOutcome: priorTimeout },
  ]) {
    assert.equal(catalogFits(seeded, start), false, 'a prior timeout disqualifies the whole catalog even with a short stored catalogMs');
    const selections: string[][] = [];
    const ports: GatePorts = {
      now: () => start, fetch: async () => tip, landings: async () => [], files: async () => ['app.ts'],
      catalog: async () => ['smoke', 'unrelated'], core: async () => [], file: async () => ({ item: null }),
      revert: async () => { throw new Error('unused'); },
      run: async (_commit, checks) => { selections.push([...checks]); return []; },
    };
    assert.equal((await runGate(ports, seeded)).outcome, 'verified');
    assert.deepEqual(selections, [['build', 'affected']], 'the next attempt runs the affected subset, not the whole catalog');
    assert.equal(seeded.verified, tip);
    assert.equal(seeded.attempt.timeouts, 0);
  }
});

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('e2e:release-check-timeout-recovers — on a running test install a release check that timed out on the whole catalog runs the affected subset next and verifies a commit', async () => {
  const base = await temporaryDirectory('release-check-timeout-recovers'), origin = join(base, 'origin.git'), checkout = join(base, 'install');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, checkout);
  await mkdir(join(checkout, 'e2e', 'cases'), { recursive: true });
  await writeFile(join(checkout, 'graphyard.json'), '{}');
  for (const id of ['smoke', 'unrelated']) await writeFile(join(checkout, 'e2e', 'cases', `${id}.json`), JSON.stringify({ id, steps: [] }));
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base');
  const before = git(checkout, 'rev-parse', 'HEAD');
  await writeFile(join(checkout, 'app.ts'), 'export const recovered = true;\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'fix release check'); git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  const head = git(checkout, 'rev-parse', 'HEAD'), file = gateRecordPath(checkout);
  await writeGateRecord(file, {
    ...bootstrapGate(repository, before),
    catalogMs: short,
    diagnosticsAt: new Date(start).toISOString(),
    attempt: { recuts: 0, timeouts: 1 },
    lastOutcome: { tip: head, outcome: 'timeout', reason: 'past 45 minutes', finishedAt: new Date(start - 60_000).toISOString() },
  });
  const selections: string[][] = [];
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => start, fetch: async () => head,
    git: async (args, extra) => execFileSync('git', ['-C', checkout, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }),
    trial: async (_commit, files, item) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      selections.push(proofs);
      assert.deepEqual(files, ['app.ts'], 'the release check runs the affected files');
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
    },
    merge: async () => { throw new Error('unused'); }, push: async () => 'pushed', holds: async () => true, record: async () => {},
    gate: { root: checkout, repository },
  };
  const cycle = { state: emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as never), effects: { mergeWriter: reads } as never,
    snapshot: { work: [], now: new Date(start).toISOString() } as never, performed: [], now: () => start, log: () => {} };
  const step = await batchGateStep(cycle);
  await step!.gate; await step!.diagnostics;
  assert.deepEqual(selections, [['e2e:graphyard-feature-map']], 'the retry runs only the affected subset, not unrelated catalog cases');
  const record = readGateRecord(file)!;
  assert.equal(record.verified, head);
  assert.equal(record.lastOutcome?.outcome, 'verified');
  assert.equal(record.attempt.timeouts, 0);
});
