import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { mergeWriterIdle, mergeWriterReads, mergeWriterStep } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { mergeRecordKey, mergeRecordKinds, type MergeRecordEvent, type MergeTrialInput } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { defaultChildRun } from '../src/child-runner.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Observation, Work } from '../src/model/work.js';
import { workFixture } from './helpers/work-fixture.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-4016: a head refused because the merge conflicted with main went back to its worker even when
// main had moved again by the time the rework was asked, and the head now merged onto it cleanly.
// The rework step re-merges the head onto the current main first: a clean merge is trialled there
// and lands with its normal trial; a head that still conflicts returns to its worker as before.

async function fixture(label: string) {
  const directory = await temporaryDirectory(label), other = join(directory, 'other');
  const { root: checkout, origin, head: baseTip } = await gitRepo({ root: join(directory, 'checkout'), files: { 'item.txt': 'base\n' }, origin: true });
  git(directory, 'clone', '-q', origin, other);
  git(checkout, 'checkout', '-qb', 'graphyard/gy-1-1');
  await writeFile(join(checkout, 'item.txt'), 'the item\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'GY-1 change');
  const head = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', '--detach', baseTip);
  /** Another change lands on main: `path` gets `content`. */
  const moveMain = async (path: string, content: string) => {
    await writeFile(join(other, path), content);
    git(other, 'add', '.'); git(other, 'commit', '-qm', `land ${path}`); git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  const candidate = { sha: head, baseSha: baseTip, pr: 0, branch: 'graphyard/gy-1-1', author: 'worker' };
  const work = workFixture({ id: 'w1', key: 'GY-1', stage: 'review', epoch: 1, submission: { epoch: 1, pr: 0 }, candidate,
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    observation: { source: 'control-plane', candidate, files: ['item.txt'], scopeFiles: [{ path: 'item.txt' }], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, at: new Date().toISOString() } as unknown as Observation,
    gates: ['ready', 'build', 'review', 'acceptance'].map(name => ({ name, passed: true, reasons: [] })) } as Partial<Work>);
  const events: { kind: string; payload: unknown; work: string; key: string }[] = [], trials: MergeTrialInput[] = [], reworks: { key: string; reason: string }[] = [];
  let onRefused = async () => {};
  const config = masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key') } } });
  const reads = mergeWriterReads(config, checkout, defaultChildRun, { base: join(directory, 'managed'),
    trial: async input => { trials.push(input); return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } }; },
    record: async (item, event: MergeRecordEvent) => {
      const { kind, ...payload } = event;
      events.push({ kind: mergeRecordKinds[kind], work: item.key, key: mergeRecordKey(item, event), payload: kind === 'intent' ? { ...payload, key: item.key } : kind === 'refused' ? { ...payload, kind: 'merge' } : payload });
      if (kind === 'refused') await onRefused();
      return {};
    } });
  const state = emptyDaemonState(config), performed: unknown[] = [];
  let clock = Date.now();
  /** One loop cycle over the ledger as recorded so far, then wait for the flight it started. */
  const step = async () => {
    clock += 1000;
    const item = { ...work, mergeLedger: foldMergeLedger(events)['GY-1'] ?? null, reworkRequested: reworks.length > 0 } as Work;
    await mergeWriterStep({ state, config, effects: { mergeWriter: reads, persist: async () => {}, rework: async (target: Work, reason: string) => { reworks.push({ key: target.key, reason }); } }, now: () => clock, snapshot: { work: [item] }, performed } as unknown as Cycle);
    await mergeWriterIdle(state);
  };
  return { origin, head, state, events, trials, reworks, moveMain, step, setOnRefused: (call: () => Promise<void>) => { onRefused = call; } };
}

test('integration:clean-base-move-goes-to-trial — a head refused for a conflict that merges cleanly onto the moved main is trialled and lands, not returned', { timeout: 60_000 }, async () => {
  const f = await fixture('clean-base-move');
  await f.moveMain('item.txt', 'a conflicting change\n');
  // Main moves again before the rework is asked: the conflicting change is taken back out (a serve revert, a fix-up).
  let cleanTip = '';
  f.setOnRefused(async () => { if (!cleanTip) cleanTip = await f.moveMain('item.txt', 'base\n'); });
  for (let cycle = 0; cycle < 6 && !f.reworks.length && !f.events.some(event => event.kind === 'merge.pushed'); cycle++) await f.step();
  assert.ok(f.events.some(event => event.kind === 'merge.refused' && /the merge conflicts in item\.txt/.test(JSON.stringify(event.payload))), 'the first trial merge conflicted with main');
  assert.deepEqual(f.reworks, [], 'the head merges cleanly onto the moved main, so it is not returned to its worker');
  const requeue = f.events.find(event => event.kind === 'merge.refused' && /merges without conflict/.test(JSON.stringify(event.payload)));
  assert.ok(requeue, 'the head is queued again for its trial on the moved main');
  assert.match(requeue.key, /^merge-record:w1:[0-9a-f-]{36}:0:refused$/, 'the requeue is written under its own attempt, never a key another refusal used');
  assert.equal(new Set(f.events.map(event => event.key)).size, f.events.length, 'no two records share an idempotency key');
  const landed = git(f.origin, 'rev-parse', 'main');
  assert.notEqual(landed, cleanTip, 'the head landed on the moved main');
  assert.deepEqual(git(f.origin, 'log', '-1', '--format=%P', landed).split(' '), [cleanTip, f.head], 'a Merge GY-1 commit onto the moved main whose second parent is the head, unchanged');
  assert.equal(f.trials.length, 1, 'the merge onto the moved main ran its trial before it landed');
  assert.equal(f.trials[0]!.mergeSha, landed, 'the trialled commit is the one that landed');
});

test('integration:clean-base-move-goes-to-trial — a head that still conflicts with the moved main returns to its worker to sync', { timeout: 60_000 }, async () => {
  const f = await fixture('conflicting-base-move');
  const conflicting = await f.moveMain('item.txt', 'a conflicting change\n');
  for (let cycle = 0; cycle < 4 && !f.reworks.length; cycle++) await f.step();
  assert.equal(f.reworks.length, 1, 'the conflicting head returns to its worker');
  assert.match(f.reworks[0]!.reason, /the merge conflicts in item\.txt\. The base moved: run sync GY-1/);
  assert.equal(f.trials.length, 0, 'no trial runs on a merge that conflicts');
  assert.equal(git(f.origin, 'rev-parse', 'main'), conflicting, 'nothing landed');
});

test('integration:clean-base-move-goes-to-trial — a conflict rework waits while the item has an unconfirmed write, then the head is trialled', { timeout: 60_000 }, async () => {
  const f = await fixture('unconfirmed-base-move');
  const reason = 'trial failed: the merge conflicts in item.txt', at = new Date().toISOString();
  // A restart left a conflict rework owed and an unconfirmed write of the same item; the head merges cleanly onto main.
  f.state.mergeWriter.reworks = [{ key: 'GY-1', id: 'w1', head: f.head, reason, refusedAt: at, attempts: 0, lastError: null }];
  f.state.mergeWriter.unconfirmed = [{ key: 'GY-1', id: 'w1', attempt: 'lost-attempt', write: 0, event: { kind: 'refused', head: f.head, reason }, sentAt: at, replays: 0, lastError: 'socket hang up' }];
  const stepped = await Promise.race([f.step().then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 10_000).unref())]);
  assert.ok(stepped, 'the cycle finishes: the rework never waits on a write only a later replay confirms');
  assert.ok(f.events.some(event => event.key === 'merge-record:w1:lost-attempt:0:refused'), 'the unconfirmed write is replayed');
  for (let cycle = 0; cycle < 6 && !f.reworks.length && !f.events.some(event => event.kind === 'merge.pushed'); cycle++) await f.step();
  assert.deepEqual(f.reworks, [], 'the head merges cleanly, so it is not returned to its worker');
  assert.equal(f.trials.length, 1, 'the head is trialled on main as it is now');
});
