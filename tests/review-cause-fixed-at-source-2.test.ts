import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completePreflight } from '../src/cli/complete.js';
import { flowNumbers } from '../src/flow-numbers.js';
import { gitRepo } from './helpers/git-repo.js';

// GY-4038: unmet acceptance criteria was code review's largest rework cause over the 24 h after
// GY-3939 shipped (7 reworks on 7 items: GY-3938, GY-3942, GY-3966, GY-4000, GY-4006, GY-4010,
// GY-4033). complete now asks the worker to verify and rule each criterion met before review does.

test('integration:review-cause-fixed-at-source-2 — complete refuses a head until a commit rules each acceptance criterion met, and refuses any ruled unmet', async () => {
  const { root, git } = await gitRepo({
    label: 'review-cause-2',
    files: { 'src/work.ts': 'export const fixture = 1;\n' },
  });
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  // Reproduces GY-3938's AC-1 finding (missed inline item() copies) and GY-3966's AC-3 finding.
  git('checkout', '-qb', 'graphyard/gy-1-1');
  await writeFile(join(root, 'src/work.ts'), 'export const fixture = 2;\n');
  git('commit', '-qam', 'GY-1: switch most tests to workFixture');

  const work = {
    key: 'GY-1',
    type: 'chore',
    criteria: [
      { id: 'AC-1', text: 'Every inline item() returning a full Work calls tests/helpers/work-fixture.ts', proofs: [] },
      { id: 'AC-2', text: 'Non-blank test lines under tests/ drop by at least 500', proofs: [] },
    ],
  };

  // Without criterion rulings, complete refuses and prints the exact unruled criteria text.
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.match(error.message, /\[AC-1\] Every inline item\(\) returning a full Work/);
    assert.match(error.message, /\[AC-2\] Non-blank test lines under tests\//);
    assert.match(error.message, /AC-N — met: HOW/);
    return true;
  });

  // Ruling a criterion unmet is refused too, until a later commit supersedes it with met.
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: check\n\nAC-1 — unmet: three files still inline item()\nAC-2 — met: 520 lines removed');
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), /AC-1.*unmet/i);
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: fix remaining files\n\nAC-1 — met: all inline item() helpers call workFixture');
  await completePreflight(root, work, git('rev-parse', 'HEAD'));

  // Ruling only one of two criteria still refuses, naming only the unruled one.
  git('reset', '-q', '--hard', 'HEAD~2');
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: partial\n\nAC-1 — met: all inline item() helpers call workFixture');
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.doesNotMatch(error.message, /\[AC-1\]/);
    assert.match(error.message, /\[AC-2\] Non-blank test lines/);
    return true;
  });

  // Once every criterion is ruled met, complete accepts.
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: rest\n\nAC-2 — met: 520 non-blank test lines removed');
  await completePreflight(root, work, git('rev-parse', 'HEAD'));
});

test('integration:review-cause-fixed-at-source-2 — master status counts the group as criterion unmet so its fall after deploy shows', () => {
  const now = Date.parse('2026-11-27T16:00:00Z');
  const findings = [
    ['GY-3938', 'tests/base-move-keeps-concurrent-trial.test.ts:15 — AC-1: item() still constructs a full Work literal by hand instead of calling tests/helpers/work-fixture.ts'],
    ['GY-4006', 'src/session-watch.ts:533 — AC-1: mainworks watch unconditionally calls supervise(..., { detached: true }), bypassing reservedCpuPrefix()'],
    ['GY-4033', 'src/cli/ask.ts:44 — AC-1: ask runs inside the caller own confined session, whose credential mask hides every account home'],
  ];
  const items = findings.map(([key, finding], index) => ({
    key, title: key, stage: 'build', stageEnteredAt: new Date(now).toISOString(), mergedAt: null, attempts: [],
    events: [{ kind: 'rework', at: new Date(now - (index + 1) * 60_000).toISOString(), binding: `abc${index}:verdict:review-codex`, reason: `${key}: review-codex requested changes on abc: BLOCKING: ${finding}. The verdict stands.` }],
  }));
  assert.deepEqual(flowNumbers(items, 24, now).reviewReasons, [{ label: 'criterion unmet', count: 3 }]);
});
