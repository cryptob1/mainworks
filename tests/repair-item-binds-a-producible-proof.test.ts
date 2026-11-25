import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, runGate } from '../src/batch-gate.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { fileLoopFault, gateFiledItem, projectProofCapabilities } from '../src/daemon/control-plane.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { commands } from '../src/engine/commands/schemas.js';
import { evaluateLandability } from '../src/model-boundary/landability.js';
import { requiredProofFailure, runMergeTrial } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { mainworksRepository } from '../src/scenarios.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();

const allProofs = (item: { criteria: readonly { proofs: readonly string[] }[] }) => item.criteria.flatMap(criterion => criterion.proofs);

test('unit:repair-item-binds-a-producible-proof — a project with only declared checks and E2E cases (as hwd-backend) gets no unit: proof for a flaky E2E case or failing preMerge check', async () => {
  // Fixture repository shaped like hwd-backend: Go repo, declared preMerge check `verify` (`make verify`), E2E cases, no Node/Python test runner.
  const base = await temporaryDirectory('repair-go-repo');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await writeFile(join(pusher, 'go.mod'), 'module example.com/hwd-backend\n');
  await writeFile(join(pusher, 'graphyard.json'), JSON.stringify({
    e2e: { serve: { command: 'true', url: 'http://127.0.0.1:8080/healthz', readySeconds: 10 } },
    gate: { core: ['graphyard-feature-map'] },
    delivery: {
      mode: 'local',
      mergeGate: {
        preMerge: [{ check: 'verify', command: 'make verify', source: 'script', reason: 'Go verification suite' }],
        perCandidate: [],
      },
      candidateSchedule: null,
      deploy: { adapter: 'command', uat: null, production: null },
    },
  }));
  await mkdir(join(pusher, 'e2e/cases'), { recursive: true });
  await writeFile(join(pusher, 'e2e/cases/x05h.json'), JSON.stringify({ id: 'x05h', title: 'x05h', target: 'any', required: false, steps: [] }));
  await writeFile(join(pusher, 'e2e/cases/graphyard-feature-map.json'), JSON.stringify({ id: 'graphyard-feature-map', title: 'Feature map', target: 'any', required: false, steps: [] }));
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-q', '-m', 'base');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  git(pusher, 'checkout', '-q', '-b', 'item-1');
  await writeFile(join(pusher, 'main.go'), 'package main\n');
  git(pusher, 'add', '.');
  git(pusher, 'commit', '-q', '-m', 'change 1');
  git(pusher, 'checkout', '-q', 'main');
  git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-1: change 1', 'item-1');
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', origin, coordinator);

  const repository = 'inspecthoa/hwd-backend';
  const filings: { item: ReturnType<typeof gateFiledItem>; key: string }[] = [];
  let e2eRuns = 0;
  const reads = {
    baseBranch: 'main',
    now: () => Date.parse('2030-04-01T00:00:00Z'),
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args: readonly string[]) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env }),
    trial: async () => {
      e2eRuns += 1;
      // First run: e2e:x05h fails once (flaky -> passes on rerun) and preMerge check `verify` fails on tip and verified (known red).
      return {
        build: 'pass',
        tests: { passed: 0, failed: ['verify'], files: 1 },
        durationMs: 1,
        logTail: '',
        files: [],
        proofs: {},
        e2e: [{ proof: 'e2e:x05h', executed: 1, failed: e2eRuns === 1 ? 1 : 0, missing: false, failingStep: null, output: [] }],
      };
    },
    createWork: async (item: ReturnType<typeof gateFiledItem>, key: string) => { filings.push({ item, key }); return { key: `GY-${filings.length + 10}` }; },
    gate: { root: coordinator, repository },
  } as unknown as MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> };

  const outcome = await runGate(batchGatePorts(reads, []), { ...bootstrapGate(repository, verified), catalogMs: 60_000 });
  assert.equal(outcome.outcome, 'verified', JSON.stringify(outcome));

  const flakyE2e = filings.find(entry => entry.key === 'flake:e2e:x05h')?.item;
  assert.ok(flakyE2e, 'flaky e2e:x05h was filed');
  assert.ok(!allProofs(flakyE2e).some(proof => /^(unit|integration):/.test(proof)), `flaky e2e item must not bind unit:/integration: proof, got ${JSON.stringify(allProofs(flakyE2e))}`);
  assert.ok(allProofs(flakyE2e).includes('e2e:x05h'), 'flaky e2e item binds e2e:x05h');
  commands.create.parse({ ...flakyE2e, reason: 'Filed by the batch gate on main' });

  const redPreMerge = filings.find(entry => entry.key === 'known-red:test:verify')?.item;
  assert.ok(redPreMerge, 'failing preMerge check verify was filed');
  assert.ok(!allProofs(redPreMerge).some(proof => /^(unit|integration):/.test(proof)), `preMerge repair item must not bind unit:/integration: proof, got ${JSON.stringify(allProofs(redPreMerge))}`);
  assert.ok(allProofs(redPreMerge).includes('check:verify'), `preMerge repair item binds check:verify, got ${JSON.stringify(allProofs(redPreMerge))}`);
  assert.ok(allProofs(redPreMerge).includes('e2e:graphyard-feature-map'), 'preMerge repair item uses existing core E2E case');
  assert.equal((redPreMerge as { plannedFiles?: string[] }).plannedFiles, undefined, 'preMerge check name is not a file path');
  commands.create.parse({ ...redPreMerge, reason: 'Filed by the batch gate on main' });
});

test('unit:repair-item-binds-a-producible-proof — a Node project with a failing test file keeps today\'s binding', () => {
  const item = gateFiledItem(
    { key: 'flake:test:tests/board-queue.test.ts', title: 'Flaky check on main: test:tests/board-queue.test.ts', description: 'Flaked on main.' },
    'main',
    mainworksRepository,
    { unitRunner: true, preMergeChecks: ['browser-tests/', 'test'], coreCase: 'create-work-item' },
  );
  assert.deepEqual(item.criteria[0]!.proofs, ['unit:board-queue-pinned']);
  assert.deepEqual(item.criteria[1]!.proofs, ['manual:batch-gate-repaired', 'e2e:create-work-item']);
  assert.deepEqual((item as { plannedFiles?: string[] }).plannedFiles, ['tests/board-queue.test.ts']);
  commands.create.parse({ ...item, reason: 'Filed by the batch gate on main' });
});

test('unit:repair-item-binds-a-producible-proof — existing open repair items are not rewritten when the same fault recurs', async () => {
  const existing = {
    id: 'w-143',
    key: 'GY-143',
    faultKey: 'flake:e2e:x05h',
    stage: 'build',
    criteria: [
      { id: 'AC-1', text: 'Old pinning text', proofs: ['unit:e2e-x05h-pinned'] },
      { id: 'AC-2', text: 'The batch gate passes again', proofs: ['manual:batch-gate-repaired', 'e2e:x05h'] },
    ],
  } as unknown as Work;
  const originalCriteria = structuredClone(existing.criteria);
  const notes: string[] = [];
  let created = 0;
  const next = gateFiledItem(
    { key: 'flake:e2e:x05h', title: 'Flaky check on main: e2e:x05h', description: 'Flaked again.' },
    'main',
    'inspecthoa/hwd-backend',
    { unitRunner: false, preMergeChecks: ['verify'], coreCase: 'graphyard-feature-map' },
  );
  const result = await fileLoopFault(
    {
      work: [existing],
      now: Date.now(),
      createWork: async () => { created += 1; return { key: 'GY-999' }; },
      note: async (_item, text) => { notes.push(text); },
    },
    next,
    'Flaked again.',
  );
  assert.equal(result.action, 'noted');
  assert.equal(created, 0);
  assert.equal(notes.length, 1);
  assert.deepEqual(existing.criteria, originalCriteria, 'existing open repair item criteria are untouched');
});

test('unit:repair-item-binds-a-producible-proof — check:NAME proof is produced by the merge trial and accepted by landability', async () => {
  const repo = await temporaryDirectory('repair-check-trial');
  const trials = await temporaryDirectory('repair-check-trials');
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'graphyard.json'), JSON.stringify({
    delivery: {
      mode: 'local',
      mergeGate: {
        preMerge: [{ check: 'verify', command: 'node --eval 0', source: 'script', reason: 'verify check' }],
        perCandidate: [],
      },
      candidateSchedule: null,
      deploy: { adapter: 'command', uat: null, production: null },
    },
  }));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'change.txt'), 'fixed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'head');
  const head = git(repo, 'rev-parse', 'HEAD');

  const run: ChildRun = async (command, args, options) => {
    if (command === 'git') return defaultChildRun(command, args, { ...options, env: { ...process.env, ...env, ...options?.env } });
    if (command === 'node' || args.includes('node')) return '';
    return defaultChildRun(command, args, options);
  };
  const trial = await runMergeTrial({
    root: repo,
    base: trials,
    mergeSha: head,
    baseTip: base,
    changedFiles: ['change.txt'],
    proofs: [],
    checkProofs: ['check:verify'],
    proofFiles: [],
    timeoutMs: 60_000,
    attribute: false,
    reproduce: false,
    run,
  } as Parameters<typeof runMergeTrial>[0]);

  assert.deepEqual(trial.proofs['check:verify'], { executed: 1, failed: 0 }, trial.logTail);
  const criteria = [{ id: 'AC-1', text: 'verify passes', proofs: ['check:verify'] }] as Work['criteria'];
  assert.equal(requiredProofFailure({ criteria }, trial), null);
  const work = {
    id: 'w-check',
    key: 'GY-200',
    stage: 'test',
    policyRevision: 1,
    candidate: { sha: head, baseSha: base, pr: 1, branch: 'graphyard/gy-200-1', author: 'worker' },
    submission: { epoch: 1, head },
    observation: { source: 'control-plane', candidate: { sha: head, baseSha: base }, files: ['change.txt'], checks: [], reviews: [] },
    mergeLedger: { state: 'intent', head, mergeSha: head, baseTip: base, events: 2, trial: { head, mergeSha: head, passedBaseTip: base, proofs: trial.proofs } },
    criteria,
    evidence: [],
    policy: { checks: ['verify'], review: true },
    workspaces: [{ host: 'h', path: '/w', epoch: 1, owner: 'worker', branch: 'main' }],
    dependencies: [],
  } as unknown as Work;
  const verdict = evaluateLandability(work, [work], new Date());
  const acceptanceReasons = verdict.verdict === 'refused' ? verdict.reasons.filter(r => r.gate === 'acceptance') : [];
  assert.deepEqual(acceptanceReasons, [], `check:verify should satisfy control-plane acceptance: ${JSON.stringify(acceptanceReasons)}`);
});

test('unit:repair-item-binds-a-producible-proof — projectProofCapabilities detects unit runners only when the project declares one', () => {
  // Go project with preMerge make verify and featureMap: no unit runner.
  const goCaps = projectProofCapabilities({
    projectConfigJson: JSON.stringify({
      featureMap: [{ name: 'Home', url: '/', traps: [] }],
      delivery: { mergeGate: { preMerge: [{ check: 'verify', command: 'make verify', source: 'script', reason: 'go' }], perCandidate: [] } },
    }),
    packageJson: null,
    hasPytest: false,
  });
  assert.equal(goCaps.unitRunner, false);
  assert.deepEqual(goCaps.preMergeChecks, ['verify']);
  assert.equal(goCaps.coreCase, 'graphyard-feature-map');

  // Go project that also has a frontend package.json without vitest, and preMerge only runs make verify: still no unit runner.
  const goWithPkg = projectProofCapabilities({
    projectConfigJson: JSON.stringify({
      delivery: { mergeGate: { preMerge: [{ check: 'verify', command: 'make verify', source: 'script', reason: 'go' }], perCandidate: [] } },
    }),
    packageJson: JSON.stringify({ scripts: { build: 'vite build', test: 'echo unused' } }),
    hasPytest: false,
  });
  assert.equal(goWithPkg.unitRunner, false);

  // Node project with scripts.test and no preMerge: has unit runner.
  assert.equal(projectProofCapabilities({ projectConfigJson: '{}', packageJson: JSON.stringify({ scripts: { test: 'node --test' } }) }).unitRunner, true);
  // Vitest project: has unit runner.
  assert.equal(projectProofCapabilities({ projectConfigJson: '{}', packageJson: JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }) }).unitRunner, true);
  // Pytest project: has unit runner.
  assert.equal(projectProofCapabilities({ projectConfigJson: '{}', packageJson: null, hasPytest: true }).unitRunner, true);
});
