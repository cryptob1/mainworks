import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeOne, pushPassedTrial, type MergePorts, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { keptTrialAheadOfReview, trialAheadOfReviewReason } from '../src/model/merge-queue.js';
import { moveTouches } from '../src/merge-writer/stale-trial.js';
import { riskOf } from '../src/model-boundary/risk-class.js';
import { mergeWriterSummary } from '../src/daemon/cycle-merge-writer.js';
import { emptyMergeWriterState } from '../src/daemon/merge-writer-state.js';
import type { Work } from '../src/model/work.js';
import { gitRepo } from './helpers/git-repo.js';

// GY-3881 AC-3: a head whose passing trial ran on a base older than the tip it lands on is trialled
// again on the new merge when it is sensitive, or when the commits that moved the tip touch a file
// its changed or selected test files import, directly or through one level. Otherwise it takes the
// GY-3120 fast path, and the landing says so for status to count.

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');

/** A repository whose base holds a TypeScript chain and one Go package, and one tip per move, each a commit on the base. */
async function repository(t: { after(fn: () => unknown): void }) {
  const { root: dir, head: base, git } = await gitRepo({ label: 'stale-trial', files: {
    'src/app.ts': "import { lib } from './lib.js';\nexport const app = lib;\n",
    'src/lib.ts': "import { deep } from './deep.js';\nexport const lib = deep;\n",
    'src/deep.ts': 'export const deep = 1;\n',
    'src/deeper.ts': 'export const deeper = 1;\n',
    'src/other.ts': 'export const other = 1;\n',
    'tests/app.test.ts': "import { app } from '../src/app.js';\nvoid app;\n",
    'go.mod': 'module example.com/hwd\n',
    'internal/inspect/report.go': 'package inspect\n\nfunc Report() {}\n',
    'internal/inspect/score.go': 'package inspect\n\nfunc Score() {}\n',
  } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = async (files: Record<string, string>, message: string) => {
    for (const [name, text] of Object.entries(files)) { await mkdir(join(dir, name, '..'), { recursive: true }); await writeFile(join(dir, name), text); }
    git('add', '.'); git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const move = async (files: Record<string, string>) => { git('checkout', '-q', '--detach', base); return write(files, 'move'); };
  const merge = (head: string, into: string) => { git('checkout', '-q', '--detach', into); git('merge', '-q', '--no-ff', '-m', 'merge', head); return git('rev-parse', 'HEAD'); };
  return { base, move, merge, git: async (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }) };
}

function world(repo: { base: string; git: (args: string[]) => Promise<string> }, movedTo: string, files: string[]) {
  const head = sha(`head:${files.join()}`);
  const item = { id: 'w1', key: 'GY-1', title: 'A change', type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    candidate: { sha: head, baseSha: repo.base, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' }, submission: { epoch: 1, pr: 1 },
    observation: { source: 'control-plane', candidate: { sha: head, baseSha: repo.base }, files }, mergeLedger: null } as unknown as Work;
  const trials: string[] = [];
  let fetches = 0, pushes = 0;
  const run = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/app.test.ts'], proofs: { 'unit:works': { executed: 1, failed: 0 } } } as MergeTrialRun;
  const ports: MergePorts = {
    baseBranch: 'main', now: () => 0, holds: async () => false, record: async () => {},
    // The trial runs on the base; the tip moves before the push lands.
    fetch: async () => fetches++ === 0 ? repo.base : movedTo,
    merge: async (_head, baseTip) => ({ mergeSha: baseTip, files }),
    trial: async mergeSha => { trials.push(mergeSha); return run; },
    push: async () => pushes++ === 0 ? 'rejected' : 'pushed',
    moveTouches: (from, to, watched, at) => moveTouches(repo.git, from, to, watched, at),
  };
  return { item, ports, trials };
}

test('unit:stale-trial-is-rerun-when-the-tip-moved-under-it — each branch: sensitive, a touched import, one level through, the fast path, and two heads in one Go package', async t => {
  const repo = await repository(t);
  const deep = await repo.move({ 'src/deep.ts': 'export const deep = 2;\n' });
  const deeper = await repo.move({ 'src/deeper.ts': 'export const deeper = 2;\n' });
  const other = await repo.move({ 'src/other.ts': 'export const other = 2;\n' });
  const sibling = await repo.move({ 'internal/inspect/report.go': 'package inspect\n\nfunc Report() { Score() }\n' });

  // The fast path: the move touches nothing the head imports; one trial, and the landing is counted as untrialled.
  const fast = world(repo, other, ['src/app.ts']);
  assert.equal(riskOf(fast.item).risk, 'normal');
  const landed = await mergeOne(fast.ports, fast.item);
  assert.equal(landed.outcome, 'merged');
  assert.equal(landed.outcome === 'merged' && landed.untrialled, true);
  assert.deepEqual(fast.trials, [repo.base]);

  // A sensitive head (an unknown change is sensitive) is trialled again on the new merge, whatever the move touched.
  const sensitive = world(repo, other, []);
  assert.equal(riskOf(sensitive.item).risk, 'sensitive');
  const again = await mergeOne(sensitive.ports, sensitive.item);
  assert.deepEqual(sensitive.trials, [repo.base, other]);
  assert.equal(again.outcome === 'merged' && again.untrialled, undefined);

  // The move touches src/deep.ts: the head's src/app.ts imports src/lib.ts, which imports it (one level through).
  const through = world(repo, deep, ['src/app.ts']);
  await mergeOne(through.ports, through.item);
  assert.deepEqual(through.trials, [repo.base, deep]);

  // The selected test file counts too: tests/app.test.ts imports src/app.ts, which imports src/lib.ts (one level through); src/deep.ts is a level further.
  const lib = await repo.move({ 'src/lib.ts': "import { deep } from './deep.js';\nexport const lib = deep + 1;\n" });
  assert.equal(await moveTouches(repo.git, repo.base, lib, ['src/other.ts', 'tests/app.test.ts']), 'src/lib.ts');
  assert.equal(await moveTouches(repo.git, repo.base, deep, ['src/other.ts', 'tests/app.test.ts']), null);
  assert.equal(await moveTouches(repo.git, repo.base, deeper, ['src/app.ts']), null, 'a file nothing imports is never a reason');

  // A file added by the head (e.g. a new proof test file absent at `to`) is read at the new merge commit, not `to`.
  const addedHead = await repo.move({ 'tests/added.test.ts': "import { lib } from '../src/lib.js';\nvoid lib;\n" });
  const mergedWithLib = repo.merge(addedHead, lib);
  const mergedWithDeep = repo.merge(addedHead, deep);
  assert.equal(await moveTouches(repo.git, repo.base, lib, ['tests/added.test.ts'], mergedWithLib), 'src/lib.ts');
  assert.equal(await moveTouches(repo.git, repo.base, deep, ['tests/added.test.ts'], mergedWithDeep), 'src/deep.ts');

  // Two heads in one Go package (the hwd-backend incident): one landed report.go, the other changed score.go.
  const goHead = world(repo, sibling, ['internal/inspect/score.go']);
  assert.equal(riskOf(goHead.item).risk, 'normal');
  const rerun = await mergeOne(goHead.ports, goHead.item);
  assert.equal(rerun.outcome, 'merged');
  assert.deepEqual(goHead.trials, [repo.base, sibling]);

  // pushPassedTrial never runs a trial synchronously when a kept trial needs a retrial; it returns false so a tracked flight runs it.
  const keptFor = (files: string[], movedTo: string) => {
    const head = sha(`kept:${files.join()}`);
    const events: MergeRecordEvent[] = [], trials: string[] = [];
    const item = { id: 'w1', key: 'GY-1', title: 'A change', type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
      candidate: { sha: head, baseSha: repo.base, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' }, submission: { epoch: 1, pr: 1 },
      observation: { source: 'control-plane', candidate: { sha: head, baseSha: repo.base }, files },
      mergeLedger: { state: 'refused', head, baseTip: repo.base, mergeSha: repo.base, refusal: { kind: 'merge', reason: trialAheadOfReviewReason('GY-1'), at: '2026-01-01T00:00:00Z' },
        trial: { head, mergeSha: repo.base, passedBaseTip: repo.base, files: ['tests/app.test.ts'], proofs: { 'unit:works': { executed: 1, failed: 0 } } } } } as unknown as Work;
    assert.equal(keptTrialAheadOfReview(item.candidate, item.mergeLedger), true);
    const ports: MergePorts = {
      baseBranch: 'main', now: () => 0, holds: async () => false,
      fetch: async () => movedTo,
      merge: async (_head, baseTip) => ({ mergeSha: baseTip, files }),
      trial: async mergeSha => { trials.push(mergeSha); throw new Error('pushPassedTrial must not run a trial'); },
      push: async () => 'pushed',
      record: async (_item, event) => { events.push(event); },
      moveTouches: (from, to, watched, at) => moveTouches(repo.git, from, to, watched, at),
    };
    return { item, ports, events, trials };
  };
  const keptSensitive = keptFor([], other);
  assert.equal(await pushPassedTrial(keptSensitive.ports, keptSensitive.item), false);
  assert.deepEqual(keptSensitive.trials, []);
  assert.deepEqual(keptSensitive.events, []);
  const keptTouched = keptFor(['src/app.ts'], deep);
  assert.equal(await pushPassedTrial(keptTouched.ports, keptTouched.item), false);
  assert.deepEqual(keptTouched.trials, []);
  assert.deepEqual(keptTouched.events, []);
  const keptFast = keptFor(['src/app.ts'], other);
  assert.deepEqual(await pushPassedTrial(keptFast.ports, keptFast.item), { untrialled: true });
  assert.deepEqual(keptFast.trials, []);

  // Status counts the fast-path landings.
  assert.equal(mergeWriterSummary({ ...emptyMergeWriterState(), untrialledLandings: 1 }).untrialledLandings, 1);
});
