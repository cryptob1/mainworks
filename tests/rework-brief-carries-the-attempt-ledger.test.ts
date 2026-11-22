import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neededRework } from '../src/daemon/rework.js';
import { appliedReworkBrief, reworkBriefMax, reworkBriefSection } from '../src/master/rework-brief.js';
import type { Work } from '../src/model.js';

const proof = 'unit:rework-brief-carries-the-attempt-ledger';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const at = (minute: number) => `2026-11-22T06:${String(minute).padStart(2, '0')}:00.000Z`;

type Entry = { attempt: number; reason: string; binding: string | null; at: string };

function workWithHistory(history: Entry[], overrides: Partial<Work> = {}): Work {
  const latest = history.at(-1)!;
  return {
    id: 'gy-3636-fixture',
    key: 'GY-500',
    title: 'Ledger fixture',
    description: '',
    type: 'feature',
    priority: 1,
    dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true },
    stage: 'build',
    revision: history.length + 1,
    policyRevision: 1,
    createdAt: at(0),
    updatedAt: latest.at,
    stageEnteredAt: latest.at,
    ready: true,
    epoch: latest.attempt,
    lease: null,
    workspaces: [],
    candidate: { sha: head, baseSha: base, pr: 500, branch: 'graphyard/gy-500-1', author: 'worker' },
    submission: { epoch: latest.attempt, pr: 500 },
    reworkRequested: true,
    lastRework: { reason: latest.reason, binding: latest.binding, at: latest.at },
    reworkHistory: history,
    pipeline: { attempts: [], submittedAt: at(1), resubmittedAt: null, reworkRounds: history.length, interventions: { blocked: 0, requirements: 0 } },
    scenarioRequirements: [],
    evidence: [],
    observation: null,
    blocker: null,
    gates: [],
    violations: [],
    ...overrides,
  } as unknown as Work;
}

function ledgerLines(brief: string): string[] {
  return brief.split('\n').filter(line => /Attempt \d+ \(/.test(line));
}

test(`${proof} — one earlier attempt lists attempt number, station and first 200 chars, then latest reason`, () => {
  const longReason = `GY-500: rev-1 requested changes on ${head.slice(0, 12)}: BLOCKING: ${'missing guard on empty list; '.repeat(12)}\nSecond line detail`;
  const work = workWithHistory([
    { attempt: 1, reason: longReason, binding: `${head}:verdict:rev-1`, at: at(5) },
  ]);
  const brief = reworkBriefSection(work, appliedReworkBrief(work));
  const lines = ledgerLines(brief);
  assert.equal(lines.length, 1, `expected 1 ledger line, got:\n${brief}`);
  assert.match(lines[0], /Attempt 1 \(review\):/);
  const summary = lines[0].split('Attempt 1 (review): ')[1] ?? '';
  assert.ok(summary.length <= 200, `expected <= 200 chars, got ${summary.length}`);
  assert.ok(summary.includes('missing guard on empty list'));
  assert.ok(brief.includes('Second line detail'), 'latest reason is carried in full beyond the 200-char ledger line');
});

test(`${proof} — three earlier attempts list all three in order with their stations`, () => {
  const history: Entry[] = [
    { attempt: 1, reason: `GY-500: rev-1 requested changes on ${head.slice(0, 12)}: BLOCKING: null check missing`, binding: `${head}:verdict:rev-1`, at: at(5) },
    { attempt: 2, reason: `GY-500: the product review requested changes on ${head.slice(0, 12)}: button overflows at 390px`, binding: `${head}:verdict:prod-rev`, at: at(10) },
    { attempt: 3, reason: `GY-500: the merge writer's trial of candidate ${head.slice(0, 12)} failed: trial failed: tests/foo.test.ts failed`, binding: `${head}:merge-writer-trial-failed`, at: at(15) },
  ];
  const work = workWithHistory(history);
  const brief = reworkBriefSection(work, appliedReworkBrief(work));
  const lines = ledgerLines(brief);
  assert.equal(lines.length, 3, `expected 3 ledger lines, got:\n${brief}`);
  assert.match(lines[0], /Attempt 1 \(review\):.*null check missing/);
  assert.match(lines[1], /Attempt 2 \(product review\):.*button overflows at 390px/);
  assert.match(lines[2], /Attempt 3 \(merge trial\):.*tests\/foo\.test\.ts failed/);
  assert.ok(brief.indexOf('Attempt 1 (review):') < brief.indexOf('Attempt 2 (product review):'));
  assert.ok(brief.indexOf('Attempt 2 (product review):') < brief.indexOf('Attempt 3 (merge trial):'));
});

test(`${proof} — six earlier attempts list all five stations in order, one line each`, () => {
  const history: Entry[] = [
    { attempt: 1, reason: `GY-500: rev-1 requested changes on ${head.slice(0, 12)}: BLOCKING: first finding`, binding: `${head}:verdict:rev-1`, at: at(5) },
    { attempt: 2, reason: `GY-500: base conflict. The base moved: run sync GY-500, resolve, then complete GY-500 EPOCH --head NEWSHA.`, binding: `${head}:conflict`, at: at(10) },
    { attempt: 3, reason: `GY-500: the product review requested changes on ${head.slice(0, 12)}: contrast too low`, binding: `${head}:verdict:prod-1`, at: at(15) },
    { attempt: 4, reason: `GY-500: the merge writer's trial of candidate ${head.slice(0, 12)} failed: trial failed: build failed`, binding: `${head}:merge-writer-trial-failed`, at: at(20) },
    { attempt: 5, reason: `GY-500: a trusted proof failed: unit:x failed on ${head.slice(0, 12)}`, binding: `${head}:proof:unit:x`, at: at(25) },
    { attempt: 6, reason: `GY-500: the merge writer's trial of candidate ${head.slice(0, 12)} failed: trial failed: the merge conflicts in src/a.ts. The base moved: run sync GY-500.`, binding: `${head}:merge-writer-trial-failed`, at: at(30) },
  ];
  const work = workWithHistory(history);
  const brief = reworkBriefSection(work, appliedReworkBrief(work));
  const lines = ledgerLines(brief);
  assert.equal(lines.length, 6, `expected 6 ledger lines, got:\n${brief}`);
  assert.match(lines[0], /Attempt 1 \(review\):.*first finding/);
  assert.match(lines[1], /Attempt 2 \(base moved\):/);
  assert.match(lines[2], /Attempt 3 \(product review\):.*contrast too low/);
  assert.match(lines[3], /Attempt 4 \(merge trial\):.*build failed/);
  assert.match(lines[4], /Attempt 5 \(acceptance\):.*unit:x failed/);
  assert.match(lines[5], /Attempt 6 \(base moved\):.*conflicts in src\/a\.ts/);
});

test(`${proof} — a 30,000-character verdict carries up to reworkBriefMax and never hits the old 2,000-character cut`, () => {
  const markerAt2500 = 'MARKER_AT_2500_MUST_SURVIVE';
  const padding = 'a'.repeat(2450) + markerAt2500 + 'b'.repeat(27550);
  assert.ok(padding.length >= 30_000);
  const candidate = { sha: head, baseSha: base, pr: 500, branch: 'graphyard/gy-500-1', author: 'worker' };
  const reviewed = {
    id: 'gy-500', key: 'GY-500', title: 'Big verdict', description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:x'] }], policy: { checks: ['test'], review: true }, stage: 'review',
    revision: 2, policyRevision: 1, createdAt: at(0), updatedAt: at(5), stageEnteredAt: at(5), ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 500 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
    observation: { candidate, checks: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: at(5), baseTip: base, baseTree: base, baseTipContained: true, reviews: [] },
    productReview: { reviewer: 'prod-1', sha: head, verdict: 'changes-requested', findings: padding, screenshots: [], at: at(5) },
  } as unknown as Work;

  const rework = neededRework(reviewed);
  assert.ok(rework, 'neededRework produces a rework for the product review verdict');
  assert.ok(!rework.reason.includes('cut short; the whole verdict is on the item'), 'never uses the old 2,000-character cut message');
  assert.ok(rework.reason.includes(markerAt2500), `rework reason must survive past 2,000 chars (len=${rework.reason.length})`);
  assert.ok(rework.reason.length > 3000 && rework.reason.length <= reworkBriefMax, `rework reason fills up to reworkBriefMax (${reworkBriefMax}), got ${rework.reason.length}`);

  const work = workWithHistory([{ attempt: 1, reason: padding, binding: `${head}:verdict:prod-1`, at: at(5) }]);
  const brief = reworkBriefSection(work, appliedReworkBrief(work));
  assert.ok(brief.includes(markerAt2500), 'reworkBriefSection carries the latest reason past 2,000 chars up to reworkBriefMax');
  assert.ok(!brief.includes('cut short; the whole verdict is on the item'));
});
