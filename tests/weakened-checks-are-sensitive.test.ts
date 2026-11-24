import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, riskOf } from '../src/model-boundary/risk-class.js';
import { mainworksChecksChanged, reviewedBeforeMerge } from '../src/model/risk-class.js';
import { evaluate } from '../src/model-boundary/gates.js';
import type { Work } from '../src/model/work.js';

const baseWork = (scopeFiles: NonNullable<NonNullable<Work['observation']>['scopeFiles']>): Work => ({
  id: 'work-1',
  key: 'GY-9999',
  title: 'Test change',
  type: 'bug',
  stage: 'build',
  ready: true,
  revision: 1,
  policyRevision: 1,
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
  stageEnteredAt: '2026-11-22T00:00:00.000Z',
  criteria: [{ id: 'AC-1', text: 'works', proofs: [] }],
  dependencies: [],
  plannedFiles: [],
  workspaces: [],
  policy: { checks: [], review: true },
  violations: [],
  evidence: [],
  gates: [],
  submission: { sha: 'a'.repeat(40), pr: 1, by: 'worker-1', at: '2026-11-22T00:00:00.000Z' },
  candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 1, branch: 'graphyard/gy-9999-1', author: 'worker-1' },
  observation: {
    source: 'control-plane',
    candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 1, branch: 'graphyard/gy-9999-1', author: 'worker-1' },
    baseTip: 'b'.repeat(40),
    mergeBase: 'b'.repeat(40),
    baseTipContained: true,
    protected: false,
    checks: [],
    reviews: [],
    merged: false,
    mergeSha: null,
    mergeable: true,
    files: scopeFiles.map(f => f.path),
    scopeFiles,
    at: '2026-11-22T00:00:00.000Z',
  },
} as unknown as Work);

test('unit:weakened-checks-are-sensitive — modifying or removing existing tests, e2e cases, scripts/ci-tests.mjs, tests/helpers/**, or graphyard.json checks is sensitive; add-only stays normal; renamed test file is sensitive', () => {
  // 1. Existing test file modified or removed -> sensitive naming path
  for (const status of ['modified', 'removed'] as const) {
    const verdict = classifyRisk([{ path: 'tests/example.test.ts', status, deletions: 1 }]);
    assert.equal(verdict.risk, 'sensitive', `existing test ${status}`);
    assert.ok(verdict.reasons.some(r => r.includes('tests/example.test.ts')), `reason names path: ${verdict.reasons}`);
  }

  // 2. Existing e2e case modified or removed -> sensitive naming path
  for (const status of ['modified', 'removed'] as const) {
    const verdict = classifyRisk([{ path: 'e2e/cases/smoke.json', status, deletions: 1 }]);
    assert.equal(verdict.risk, 'sensitive', `existing e2e case ${status}`);
    assert.ok(verdict.reasons.some(r => r.includes('e2e/cases/smoke.json')), `reason names path: ${verdict.reasons}`);
  }

  // 3. scripts/ci-tests.mjs -> sensitive naming path
  const selector = classifyRisk([{ path: 'scripts/ci-tests.mjs', status: 'modified', deletions: 1 }]);
  assert.equal(selector.risk, 'sensitive');
  assert.ok(selector.reasons.some(r => r.includes('scripts/ci-tests.mjs')), `reason names path: ${selector.reasons}`);

  // 4. tests/helpers/** -> sensitive naming path
  const helper = classifyRisk([{ path: 'tests/helpers/run-tests.ts', status: 'modified', deletions: 1 }]);
  assert.equal(helper.risk, 'sensitive');
  assert.ok(helper.reasons.some(r => r.includes('tests/helpers/run-tests.ts')), `reason names path: ${helper.reasons}`);
  const timing = classifyRisk([{ path: 'tests/helpers/timing-baseline.json', status: 'modified', deletions: 1 }]);
  assert.equal(timing.risk, 'sensitive');
  assert.ok(timing.reasons.some(r => r.includes('tests/helpers/timing-baseline.json')), `reason names path: ${timing.reasons}`);

  // 5. graphyard.json checks section -> sensitive naming path; non-checks section stays normal
  const checksMod = classifyRisk([{ path: 'graphyard.json', status: 'modified', checksChanged: true }]);
  assert.equal(checksMod.risk, 'sensitive');
  assert.ok(checksMod.reasons.some(r => r.includes('graphyard.json')), `reason names path: ${checksMod.reasons}`);
  const nonChecks = classifyRisk([{ path: 'graphyard.json', status: 'modified', checksChanged: false }]);
  assert.equal(nonChecks.risk, 'normal');
  assert.equal(
    mainworksChecksChanged(
      JSON.stringify({ delivery: { mergeGate: { preMerge: [{ check: 'test', command: 'npm test' }] } }, featureMap: [] }),
      JSON.stringify({ delivery: { mergeGate: { preMerge: [{ check: 'test', command: 'true' }] } }, featureMap: [] }),
    ),
    true,
  );
  assert.equal(
    mainworksChecksChanged(
      JSON.stringify({ delivery: { mergeGate: { preMerge: [{ check: 'test', command: 'npm test' }] } }, featureMap: [{ name: 'A' }] }),
      JSON.stringify({ delivery: { mergeGate: { preMerge: [{ check: 'test', command: 'npm test' }] } }, featureMap: [{ name: 'B' }] }),
    ),
    false,
  );

  // 6. Add-only new test file and new e2e case -> stays normal
  const addOnly = classifyRisk([
    { path: 'src/model/feature.ts', status: 'modified', additions: 5, deletions: 0 },
    { path: 'tests/brand-new-feature.test.ts', status: 'added', additions: 40, deletions: 0, baseSha: null },
    { path: 'e2e/cases/brand-new-feature.json', status: 'added', additions: 15, deletions: 0, baseSha: null },
  ]);
  assert.deepEqual(addOnly, { risk: 'normal', reasons: [] });

  // 7. Renamed test file -> sensitive naming path
  const renamed = classifyRisk([{ path: 'tests/renamed.test.ts', previousPath: 'tests/original.test.ts', status: 'renamed', additions: 0, deletions: 0 }]);
  assert.equal(renamed.risk, 'sensitive');
  assert.ok(
    renamed.reasons.some(r => r.includes('tests/original.test.ts') || r.includes('tests/renamed.test.ts')),
    `renamed test reason names path: ${renamed.reasons}`,
  );

  // 8. A sensitive change does not merge ahead of its review
  assert.equal(reviewedBeforeMerge('sensitive'), true);
  const work = baseWork([{ path: 'tests/example.test.ts', status: 'modified', sha: 'c'.repeat(40), additions: 1, deletions: 1, binary: false }]);
  assert.equal(riskOf(work).risk, 'sensitive');
  const evaluated = evaluate(work, [work], new Date('2026-11-22T01:00:00.000Z'));
  const reviewGate = evaluated.gates.find(g => g.name === 'review')!;
  assert.equal(reviewGate.passed, false, 'sensitive change cannot pass review gate without independent approval');
  assert.ok(reviewGate.reasons.some(r => r.includes('tests/example.test.ts')), `review refusal names path: ${reviewGate.reasons}`);
});
