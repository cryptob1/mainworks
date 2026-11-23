import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeQueue } from '../src/merge-writer/executor.js';
import { effectivePriority } from '../src/model/merge-queue.js';
import { waitDueAt } from '../src/model/liveness.js';
import type { Work } from '../src/model.js';

// GY-3695: the merge queue ages — a head counts one priority level higher per full hour it has waited for its trial, never above 1; priority 0 keeps 0.

const start = Date.parse('2030-04-01T00:00:00Z');
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const candidate = (n: number, at: number) => ({ sha: `${n}`.padStart(40, 'a'), baseSha: 'b'.repeat(40), pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker', createdAt: iso(at) });
const head = (n: number, priority: number, submittedAt: number, title = `Feature ${n}`) => ({
  id: `w${n}`, key: `GY-${n}`, title, priority, stage: 'build', createdAt: iso(submittedAt), stageEnteredAt: iso(submittedAt), updatedAt: iso(submittedAt),
  submission: { epoch: 1, pr: n }, candidate: candidate(n, submittedAt), reworkRequested: false,
  observation: { source: 'control-plane', candidate: candidate(n, submittedAt), merged: false },
  gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }],
}) as unknown as Work;
const order = (work: Work[], now = start) => mergeQueue(work, {}, now).queue.map(entry => entry.key);

test('unit:merge-queue-ages — a priority 2 head that waited 61 minutes is trialled before a fresh priority 1 head', () => {
  assert.deepEqual(order([head(2, 1, start), head(1, 2, start - 61 * minute)]), ['GY-1', 'GY-2']);
  // Under a full hour it has not aged yet.
  assert.deepEqual(order([head(2, 1, start), head(1, 2, start - 59 * minute)]), ['GY-2', 'GY-1']);
});

test('unit:merge-queue-ages — a priority 3 head that waited 121 minutes is trialled before a fresh priority 1 head', () => {
  assert.deepEqual(order([head(2, 1, start), head(1, 3, start - 121 * minute)]), ['GY-1', 'GY-2']);
});

test('unit:merge-queue-ages — a fresh priority 0 head goes before all, and aging never lifts a head above 1', () => {
  assert.deepEqual(order([head(1, 3, start - 600 * minute), head(2, 1, start - 300 * minute), head(3, 0, start)]), ['GY-3', 'GY-1', 'GY-2']);
  assert.equal(effectivePriority(3, 600 * minute), 1);
  assert.equal(effectivePriority(0, 600 * minute), 0);
  assert.equal(effectivePriority(2, 61 * minute), 1);
});

test('unit:merge-queue-ages — equal effective priority falls back to oldest first, and the queue shows each wait and effective priority', () => {
  const queue = mergeQueue([head(2, 1, start - 10 * minute), head(1, 2, start - 70 * minute), head(3, 1, start)], {}, start).queue;
  assert.deepEqual(queue.map(entry => entry.key), ['GY-1', 'GY-2', 'GY-3']);
  assert.deepEqual(queue.map(entry => [entry.waitingMs, entry.priority]), [[70 * minute, 1], [10 * minute, 1], [0, 1]]);
});

test('unit:merge-queue-ages — the merge-writer stale wait is due only after a head has waited 2 hours', () => {
  const item = head(1, 2, start);
  assert.equal(waitDueAt(item, { kind: 'session', on: 'merge-writer', detail: 'queued' } as never, [item], new Date(start + minute)), iso(start + 120 * minute));
});

test('e2e:old-head-is-not-starved — one priority 2 head among a steady stream of priority 1 heads is trialled within 70 simulated minutes', () => {
  // Stub trial: one slot, 10 minutes per trial; a new priority 1 head arrives every 5 minutes from the start.
  const trialMs = 10 * minute, arrivalMs = 5 * minute;
  const waiting: Work[] = [head(1, 2, start)];
  let next = 2, arrived = start;
  let trialledAt: number | null = null;
  for (let now = start; now <= start + 180 * minute && trialledAt === null; now += trialMs) {
    while (arrived <= now) { waiting.push(head(next++, 1, arrived + 1000)); arrived += arrivalMs; }
    const picked = mergeQueue(waiting, {}, now).next!;
    waiting.splice(waiting.indexOf(picked), 1);
    if (picked.key === 'GY-1') trialledAt = now;
  }
  assert.ok(trialledAt !== null, 'the priority 2 head was never trialled');
  assert.ok(trialledAt - start <= 70 * minute, `the priority 2 head waited ${(trialledAt - start) / minute} minutes`);
});
