import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeOne, type MergePorts, type MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model/work.js';

// GY-3881 AC-1: an open flaky-check item never excuses a failing file on its own. A file is
// excused only when it also fails on the base tip (a known red); one that passes there is the
// candidate's failure, even when the candidate is the flaky-check item itself.

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const tip = sha('tip'), head = sha('head'), file = 'tests/flaky.test.ts';
const flakyItem = { id: 'w9', key: 'GY-9' };
const candidateFor = (key: string, id: string) => ({
  id, key, title: 'A change', type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  candidate: { sha: head, baseSha: tip, pr: 1, branch: 'graphyard/gy-1-1', author: 'worker' }, submission: { epoch: 1, pr: 1 },
  observation: { source: 'control-plane', candidate: { sha: head, baseSha: tip }, files: ['src/app.ts'] }, mergeLedger: null,
}) as unknown as Work;

async function merge(candidate: Work, flakyOpen: boolean, baseRed: boolean) {
  const run: MergeTrialRun = { build: 'pass', tests: { passed: 1, failed: [file], files: 2 }, durationMs: 1, logTail: '', files: ['tests/works.test.ts', file],
    proofs: { 'unit:works': { executed: 1, failed: 0 } }, ...(baseRed ? { base: { tip, files: [file], tests: ['flaky case'], cases: ['flaky case'] } } : {}) };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => 0, fetch: async () => tip, holds: async () => false,
    merge: async () => ({ mergeSha: sha('merge'), files: ['src/app.ts'] }), trial: async () => run, push: async () => 'pushed',
    record: async () => {}, flaky: async check => flakyOpen && check === `test:${file}` ? flakyItem : null, note: async () => {},
  };
  return mergeOne(ports, candidate);
}

test('unit:flaky-item-never-excuses-a-candidate-failure — a failing file is excused only when it fails on the base tip too', async () => {
  const candidate = candidateFor('GY-1', 'w1');
  const refused = await merge(candidate, true, false);
  assert.equal(refused.outcome, 'refused', 'flaky item open, base green: the candidate does not land');
  assert.match(refused.outcome === 'refused' ? refused.reason : '', /tests\/flaky\.test\.ts/);
  assert.equal((await merge(candidate, true, true)).outcome, 'merged', 'flaky item open, base red: excused as a known red');
  assert.equal((await merge(candidate, false, true)).outcome, 'merged', 'no item, base red: excused as a known red');
  const own = await merge(candidateFor('GY-9', 'w9'), true, false);
  assert.equal(own.outcome, 'refused', "the flaky item's own head breaking its file does not land");
  assert.match(own.outcome === 'refused' ? own.reason : '', /tests\/flaky\.test\.ts/);
});
