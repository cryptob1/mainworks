import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completePreflight } from '../src/cli/complete.js';
import { flowNumbers } from '../src/flow-numbers.js';
import { gitRepo } from './helpers/git-repo.js';

// GY-3939: a weakened assertion was review's largest rework cause over 24 h (GY-3881, GY-3894,
// GY-3919, GY-3925). complete now asks the worker to rule on each changed assertion first.

const keywords = "  assert.ok(keywords.includes('agents'), 'package.json keywords name the search terms');";

test('integration:review-cause-fixed-at-source — complete refuses a head that drops an existing assertion until a commit rules on it', async () => {
  const text = (lines: string[]) => ["test('readme', () => {", "  assert.ok(readme.includes('npm'));", ...lines, '});', ''].join('\n');
  const { root, git } = await gitRepo({ label: 'review-cause', files: { 'tests/readme.test.ts': text([keywords]) } });
  const file = (lines: string[]) => writeFile(join(root, 'tests/readme.test.ts'), text(lines));
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  // GY-3925's finding: the keywords check deleted from tests/readme-commands-and-links-resolve.test.ts.
  git('checkout', '-qb', 'graphyard/gy-1-1');
  await file([]); git('commit', '-qam', 'GY-1: shorten the readme test');
  const work = { key: 'GY-1', type: 'chore', criteria: [] };
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.match(error.message, /tests\/readme\.test\.ts:3/);
    assert.match(error.message, /kept meaning/);
    return true;
  });

  // A commit that rules the change "weakened" is refused too; ruled "kept meaning", it submits.
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: tests/readme.test.ts:3 — weakened');
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), /weakened/);
  git('reset', '-q', '--hard', 'HEAD~1');
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: rulings\n\ntests/readme.test.ts:3 — kept meaning: package.json has no keywords any more');
  await completePreflight(root, work, git('rev-parse', 'HEAD'));
});

test('integration:review-cause-fixed-at-source — master status counts the group as its own review reason, so its fall after deploy shows', () => {
  const now = Date.parse('2026-11-26T20:00:00Z');
  const findings = [
    ['GY-3881', 'tests/pipeline-trial-known-flaky.test.ts:26 — weakened assertion: the old line checked the rework disposition'],
    ['GY-3894', 'tests/action-claim-order.test.ts:75 — Weakened assertion (AC-1): replaced the claimAction check with openActions'],
    ['GY-3925', 'tests/readme-commands-and-links-resolve.test.ts:25 — The check that package.json keywords include the search terms was deleted and nothing replaces it'],
  ];
  const items = findings.map(([key, finding], index) => ({ key, title: key, stage: 'build', stageEnteredAt: new Date(now).toISOString(), mergedAt: null, attempts: [],
    events: [{ kind: 'rework', at: new Date(now - (index + 1) * 60_000).toISOString(), binding: `abc${index}:verdict:review-codex`, reason: `${key}: review-codex requested changes on abc: BLOCKING: ${finding}. The verdict stands.` }] }));
  assert.deepEqual(flowNumbers(items, 24, now).reviewReasons, [{ label: 'weakened assertion', count: 3 }]);
});
