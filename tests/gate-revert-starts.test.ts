import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, runGate, type GateRecord } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import { heavyTrial, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { declarationSlot, heldSlots, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3802: on 2026-11-24 the gate's revert of GY-3627 held a host heavy-job slot for over 25 minutes
// and never created its trial; nothing deployed. A gate revert now starts its trial within its
// start bound of taking the slot, or gives the slot back and says what it was waiting on.

const repository = 'owner/project', check = 'test:tests/a.test.ts', startMs = 1_000;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;
const culprit = { id: 'w2', key: 'GY-2', title: 'change', description: 'change', type: 'feature', priority: 2, criteria: [{ id: 'AC-1', text: 'works', proofs: ['unit:works'] }], mergeLedger: null } as unknown as Work;

const previous = process.env[slotsDirectoryVariable];
after(() => { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; });
const holders = (directory: string) => heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(entry => entry.owner?.label);

/**
 * A main whose verified base is followed by one `Merge GY-2` landing that breaks `check`, a host
 * heavy-job budget of one, and the real gate ports over that checkout. Every revert trial takes the
 * slot through the loop's own `heavyTrial`; `trial(call)` is what it does once it has the slot.
 */
async function world(label: string, trial: (call: number, onStep?: (step: string) => void) => Promise<MergeTrialRun>) {
  const base = await temporaryDirectory(label), slots = join(base, 'heavy-jobs');
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, 'limit'), '1\n');
  process.env[slotsDirectoryVariable] = slots;
  const coordinator = join(base, 'coordinator');
  const { root: pusher, origin } = await gitRepo({ root: join(base, 'pusher'), origin: true, files: { 'graphyard.json': '{}' } });
  const verified = git(pusher, 'rev-parse', 'HEAD');
  git(pusher, 'checkout', '-q', '-b', 'gy-2');
  await writeFile(join(pusher, 'a.ts'), 'broken\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'GY-2: change');
  git(pusher, 'checkout', '-q', 'main');
  git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-2: change', 'gy-2'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);
  let calls = 0;
  const relands: string[] = [];
  const reads = {
    baseBranch: 'main', now: Date.now, revertStartMs: startMs,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args: string[], extra?: Record<string, string>) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    trial: (_sha: string, _files: readonly string[], item: { key: string }, _base?: string, onStep?: (step: string) => void, _t?: unknown, _h?: unknown, _s?: unknown, signal?: AbortSignal) =>
      heavyTrial(item.key, onStep, signal, () => { onStep?.('checkout'); return trial(++calls, onStep); }),
    push: async (sha: string, baseTip: string) => { git(coordinator, 'push', '-q', `--force-with-lease=main:${baseTip}`, 'origin', `${sha}:refs/heads/main`); return 'pushed' as const; },
    createWork: async (_input: unknown, key: string) => { relands.push(key); return { key: 'GY-3' }; },
    record: async () => undefined,
  } as unknown as MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> };
  const steps: string[] = [];
  const record: GateRecord = bootstrapGate(repository, verified);
  // The gate's checks answer by commit: the landing breaks `check`, which passes on the verified base.
  const ports = { ...batchGatePorts(reads, [culprit]), checkpoint: async () => { if (record.inFlight?.step) steps.push(record.inFlight.step); },
    run: async (commit: string, checks: readonly string[]) => checks.map(entry => entry === 'affected' ? check : entry).filter(entry => entry === check && commit !== verified) };
  return { slots, origin, tip, record, steps, relands, gate: () => runGate(ports, record) };
}

/** A trial that took its slot and never gets past creating its checkout, deaf to every signal. */
const neverStarts = () => new Promise<MergeTrialRun>(() => {});

test('integration:gate-revert-starts — a gate revert whose trial cannot start gives its heavy-job slot back within its start bound and the gate step text says what it waited on', { timeout: 30_000 }, async () => {
  const yard = await world('gate-revert-stuck', neverStarts);
  const began = Date.now();
  const outcome = await yard.gate();
  const tookMs = Date.now() - began;
  assert.equal(outcome.outcome, 'retry', `the stuck revert ends the gate run as a retry, not a wait: ${JSON.stringify(outcome)}`);
  assert.match((outcome as { reason: string }).reason, /GY-2's merge .* did not start its trial within 1 s of taking its heavy-job slot: it was still creating its checkout, so it gave the slot back/);
  assert.ok(tookMs < startMs + 10_000, `the gate gave up within its start bound, took ${tookMs} ms`);
  assert.deepEqual(holders(yard.slots), [], 'the stuck revert holds no heavy-job slot');
  assert.ok(yard.steps.includes(`reverting GY-2 for ${check}: checkout`), `the step text names the wait while it lasts: ${JSON.stringify(yard.steps)}`);
  assert.match(yard.steps.at(-1)!, new RegExp(`^reverting GY-2 for ${check}: gave its heavy-job slot back: its trial was still creating its checkout after 1 s$`), 'and why the slot went back');
  assert.equal(git(yard.origin, 'rev-parse', 'main'), yard.tip, 'nothing was pushed');
});

test('e2e:gate-revert-starts — a gate revert of a seeded culprit whose first trial cannot start reaches reverted on the next gate run, with no loop restart', { timeout: 60_000 }, async () => {
  const yard = await world('gate-revert-e2e', async (call, onStep) => {
    if (call === 1) return neverStarts();
    onStep?.('install');
    return passing;
  });
  const first = await yard.gate();
  assert.equal(first.outcome, 'retry', `the first revert's trial could not start: ${JSON.stringify(first)}`);
  assert.deepEqual(holders(yard.slots), [], 'its slot went back');
  // The loop's next cycle runs the gate again on the same record, in the same process.
  const second = await yard.gate();
  assert.equal(second.outcome, 'reverted', `the next gate run reverts the culprit: ${JSON.stringify(second)}`);
  const main = git(yard.origin, 'rev-parse', 'main');
  assert.notEqual(main, yard.tip, 'the revert is pushed onto main');
  assert.equal(git(yard.origin, 'rev-parse', `${main}^`), yard.tip, 'on the tip it was trialled on');
  assert.match(git(yard.origin, 'log', '-1', '--format=%s', main), /^Revert "Merge GY-2: change"$/);
  assert.equal(yard.relands.length, 1, 'the re-land is filed');
  assert.deepEqual(holders(yard.slots), [], 'and no slot is left held');
});
