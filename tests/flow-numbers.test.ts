import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowAttention, flowNumbers, type FlowItem } from '../src/flow-numbers.js';

// GY-3624: flow numbers for a window, from item histories and trial ledgers.
const now = Date.parse('2026-11-21T12:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const attempt = (claimed: number, ended: number | null, end: string | null) => ({ claimedAt: at(claimed), endedAt: ended === null ? null : at(ended), end });
const stage = (stage: string, minutesAgo: number) => ({ kind: 'submit', at: at(minutesAgo), stage });

// Merged first time: built 30 min, reviewed 20, queued 10, trial 15, acceptance 5, merging 5.
const first: FlowItem = { key: 'GY-1', title: 'First', stage: 'done', stageEnteredAt: at(100), mergedAt: at(100),
  attempts: [attempt(200, 155, 'submitted')],
  events: [stage('ready', 210), stage('build', 185), stage('review', 155), stage('test', 135), { kind: 'merge.intent', at: at(125) }, { kind: 'merge.trial', at: at(112) },
    stage('acceptance', 110), stage('merge', 105), stage('done', 100)] };
// Sent back twice — once by review, once by the merge trial — then merged; its first trial flaked.
const twice: FlowItem = { key: 'GY-2', title: 'Twice', stage: 'done', stageEnteredAt: at(20), mergedAt: at(20),
  attempts: [attempt(300, 280, 'submitted'), attempt(250, 230, 'submitted'), attempt(200, 180, 'submitted')],
  events: [stage('build', 300), stage('review', 280), { kind: 'rework', at: at(270), reason: 'GY-2: reviewer requested changes on abc', binding: 'abc:verdict:reviewer' }, stage('build', 270),
    stage('test', 230), { kind: 'merge.intent', at: at(225) }, { kind: 'merge.trial', at: at(215), flaky: true },
    { kind: 'rework', at: at(210), reason: "GY-2: the merge writer's trial of candidate abc failed: trial failed: tests/x.test.ts", binding: 'abc:merge-writer-trial-failed' },
    stage('build', 210), stage('test', 180), { kind: 'merge.intent', at: at(170) }, { kind: 'merge.trial', at: at(160) }, stage('merge', 25), stage('done', 20)] };
// Abandoned: the worker let its lease lapse; the item still waits for a worker.
const abandoned: FlowItem = { key: 'GY-3', title: 'Abandoned', stage: 'ready', stageEnteredAt: at(40), mergedAt: null,
  attempts: [attempt(100, 40, 'expired')], events: [stage('build', 100), stage('ready', 40)] };
// A merge reverted after it landed.
const reverted: FlowItem = { key: 'GY-4', title: 'Reverted', stage: 'done', stageEnteredAt: at(60), mergedAt: at(60),
  attempts: [attempt(120, 90, 'submitted')], events: [stage('build', 120), stage('test', 90), { kind: 'merge.intent', at: at(80) }, { kind: 'merge.trial', at: at(70) },
    stage('done', 60), { kind: 'merge.serve-revert', at: at(30), reverted: true }] };
// Waiting two hours in review.
const waiting: FlowItem = { key: 'GY-5', title: 'Waiting', stage: 'review', stageEnteredAt: at(120), mergedAt: null,
  attempts: [attempt(150, 120, 'submitted')], events: [stage('build', 150), stage('review', 120)] };

test('unit:flow-numbers — a first-time merge, a twice-reworked merge, an abandoned attempt, a flaky trial and a revert over 6 hours', () => {
  const flow = flowNumbers([first, twice, abandoned, reverted, waiting], 6, now);
  // Ended attempts: GY-1 merged, GY-2's three (two reworked, one merged), GY-3 abandoned, GY-4 merged; GY-5 still in review.
  assert.equal(flow.attempts, 6);
  assert.equal(flow.attemptsPerHour, 1);
  assert.equal(flow.merges, 3);
  assert.equal(flow.mergesPerHour, 0.5);
  assert.equal(flow.firstPassYield, 0.5);
  assert.deepEqual(flow.rework, { review: 1, 'product review': 0, 'merge trial': 1, acceptance: 0, 'base moved': 0, 'red base': 0 });
  assert.deepEqual({ trials: flow.trials, flaky: flow.flaky, flakyRate: flow.flakyRate }, { trials: 4, flaky: 1, flakyRate: 0.25 });
  assert.deepEqual({ reverts: flow.reverts, revertRate: flow.revertRate }, { reverts: 1, revertRate: 1 / 3 });
  // Review: GY-1 20 min, GY-2 10 min, GY-5 120 min and still there, so it is the oldest.
  assert.deepEqual(flow.stations.review, { median: 20, p90: 120, samples: 3, oldest: { key: 'GY-5', title: 'Waiting', minutes: 120, waiting: true } });
  // The test stage splits at the merge intent: queued before it, in the merge trial after it.
  const { oldest: _queued, ...queue } = flow.stations['test queue']!;
  assert.deepEqual(queue, { median: 10, p90: 10, samples: 4 });
  assert.deepEqual(flow.stations['merge trial'], { median: 15, p90: 145, samples: 4, oldest: { key: 'GY-2', title: 'Twice', minutes: 145, waiting: false } });
  assert.deepEqual(flow.stations.ready, { median: 25, p90: 40, samples: 2, oldest: { key: 'GY-3', title: 'Abandoned', minutes: 40, waiting: true } });
  assert.equal(flow.stations.acceptance?.samples, 1);
  assert.equal(flow.stations.merge?.samples, 2);
  const attention = flowAttention(flow);
  assert.equal(attention!.text, 'Merge trial is slow: the slowest tenth waited 2 h 25 min over the last 6 hours. Longest: GY-2 Twice, 2 h 25 min.');
  assert.equal(attention!.next, 'graphyard status GY-2');
});

test('unit:flow-numbers — rework causes are read from the rework reason and its ground', () => {
  const rework = (reason: string, binding: string | null) => ({ kind: 'rework', at: at(10), reason, binding });
  const item: FlowItem = { key: 'GY-6', title: 'Causes', stage: 'build', stageEnteredAt: at(5), mergedAt: null, attempts: [], events: [
    rework('GY-6: the product review requested changes on abc: findings', 'abc:verdict:product-reviewer'),
    rework('GY-6: unit:x failed', 'abc:proof:unit:x'),
    rework('GY-6: GitHub reports that candidate abc conflicts. The base moved: run sync', 'abc:sync:def'),
    rework("GY-6: the merge writer's trial of candidate abc failed: trial failed: the merge conflicts in a.ts. The base moved", 'abc:merge-writer-trial-failed'),
    rework('GY-6: tests fail on the base tip too: base failure', null),
    rework('Please redo the layout', null)] };
  assert.deepEqual(flowNumbers([item], 24, now).rework, { review: 1, 'product review': 1, 'merge trial': 0, acceptance: 1, 'base moved': 2, 'red base': 1 });
});

test('unit:flow-numbers — an empty window has no rates, no stations and no attention', () => {
  const flow = flowNumbers([first], 1, now + 10 * 3_600_000);
  assert.deepEqual({ attempts: flow.attempts, merges: flow.merges, firstPassYield: flow.firstPassYield, flakyRate: flow.flakyRate, revertRate: flow.revertRate },
    { attempts: 0, merges: 0, firstPassYield: null, flakyRate: null, revertRate: null });
  assert.ok(Object.values(flow.stations).every(station => station === null));
  assert.equal(flowAttention(flow), null);
  assert.equal(flowNumbers([], 24, now).attemptsPerHour, 0);
});
