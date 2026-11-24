import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { flowAttention, flowNumbers, flowWindows, type FlowItem } from '../src/flow-numbers.js';
import { sharedFlow } from '../src/server/flow.js';
import { FlowLine } from '../web/pages/work.js';

// GY-3763: every reader — master status, Home and the loop — is served one stored flow result with
// its age. Readers at once start one computation; a reader a minute later starts the next and is
// still answered from the stored one; the numbers are those computed, and Home shows their age.
const t0 = Date.parse('2026-11-23T12:00:00Z');
const at = (minutesAgo: number) => new Date(t0 - minutesAgo * 60_000).toISOString();
const items: FlowItem[] = [
  { key: 'GY-1', title: 'First', stage: 'done', stageEnteredAt: at(30), mergedAt: at(30), attempts: [{ claimedAt: at(90), endedAt: at(60), end: 'submitted' }], events: [] },
  { key: 'GY-2', title: 'Sent back', stage: 'ready', stageEnteredAt: at(100), mergedAt: null, attempts: [{ claimedAt: at(200), endedAt: at(150), end: 'submitted' }],
    events: [{ kind: 'rework', at: at(100), reason: "GY-2: the merge writer's trial of candidate b failed: trial failed", binding: 'b:merge-writer-trial-failed' }] },
];
const work = items.map(item => ({ id: `id-${item.key}`, key: item.key, title: item.title, stage: item.stage, stageEnteredAt: item.stageEnteredAt, delivery: null, observation: null, reportedBy: item.key === 'GY-1' ? 'reporter' : 'operator' })) as any[];
const numbers = (list: FlowItem[], now: number) => {
  const windows = Object.fromEntries(Object.entries(flowWindows).map(([name, hours]) => [name, flowNumbers(list, hours, now)])) as any;
  return { ...windows, attention: flowAttention(windows['24h']) };
};

test('unit:flow-readers-share-one-result — concurrent readers start one computation, later readers get the stored numbers with their age, and Home shows it', async () => {
  const key = {};
  let computations = 0, release!: () => void;
  const compute = async (now: number) => {
    computations++;
    if (computations === 2) await new Promise<void>(resolve => { release = resolve; });
    return { at: now, work, flow: { ...numbers(items, now), items } };
  };

  // Five readers at once: one computation, one result, age 0, the same numbers as computing them directly.
  const first = await Promise.all(Array.from({ length: 5 }, () => sharedFlow(key, t0, compute)));
  assert.equal(computations, 1);
  const { attention, ...direct } = numbers(items, t0);
  for (const answer of first) {
    assert.deepEqual({ '6h': answer['6h'], '24h': answer['24h'], '7d': answer['7d'] }, direct);
    assert.deepEqual(answer.attention, attention);
    assert.deepEqual([answer.asOf, answer.ageSeconds], [new Date(t0).toISOString(), 0]);
  }
  assert.equal(first[0]['24h'].firstPassYield, 0.5);

  // Within the minute: no computation, the stored result with its age.
  const half = await sharedFlow(key, t0 + 30_000, compute);
  assert.equal(computations, 1);
  assert.deepEqual([half.asOf, half.ageSeconds], [first[0].asOf, 30]);

  // A minute on: one reader starts the next computation; it and every reader while it runs are served the stored result.
  const late = await Promise.all([sharedFlow(key, t0 + 61_000, compute), sharedFlow(key, t0 + 62_000, compute)]);
  assert.equal(computations, 2);
  assert.deepEqual(late.map(answer => [answer.asOf, answer.ageSeconds]), [[first[0].asOf, 61], [first[0].asOf, 62]]);
  release(); await new Promise(resolve => setImmediate(resolve));
  const fresh = await sharedFlow(key, t0 + 63_000, compute);
  assert.equal(computations, 2);
  assert.deepEqual([fresh.asOf, fresh.ageSeconds], [new Date(t0 + 61_000).toISOString(), 2]);

  // A reporter sees only its own items' numbers, from the stored histories: no new computation.
  const own = await sharedFlow(key, t0 + 64_000, compute, list => list.filter(item => (item as any).reportedBy === 'reporter'));
  assert.equal(computations, 2);
  assert.deepEqual([own['24h'].attempts, own['24h'].firstPassYield], [1, 1]);

  // Home: the numbers and, beside them, how old they are.
  const html = renderToStaticMarkup(createElement(FlowLine, { flow: half }));
  assert.match(html, /data-flow-attempts="true">[^<]*attempts an hour/);
  assert.match(html, /data-flow-yield="true">50% first pass/);
  assert.match(html, /data-flow-age="true">as of 30 s ago</);
});
