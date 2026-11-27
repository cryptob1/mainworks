import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flowNumbers } from '../src/flow-numbers.js';
import { oldPlannerNameLines } from './no-old-name.test.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4024: Help text that still called the planner "the Master" was product review's largest rework
// cause over 24 h (GY-3988, GY-3994). tests/no-old-name.test.ts, a static rule complete runs, now names it first.

const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name)));
// GY-3988's finding: faq-app-url still said "the master refuses".
const faqAppUrl = "  ['faq-app-url', 'How do teammates open my app?', <>Use a tailnet or public address; the master refuses <code>127.0.0.1</code>. <code>{COMMAND_NAME} master status</code> lists it.</>],";

test('integration:product-review-cause-fixed-at-source — the static rule complete runs names Help text that calls the planner the Master', async () => {
  const root = await temporaryDirectory('planner-name');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: clean }).trim();
  git('init', '-q', '-b', 'main');
  await mkdir(join(root, 'web/pages'), { recursive: true });
  await mkdir(join(root, 'src/guide'), { recursive: true });
  await writeFile(join(root, 'web/pages/guide.tsx'), `const faq = [\n${faqAppUrl}\n];\n`);
  // GY-3994's finding: the Setup Reference fold said "a Master fault … The Master implements"; command and unit names stay.
  await writeFile(join(root, 'src/guide/setup.ts'), 'export default `Run \\`mainworks master status\\`; graphyard-master-OWNER-NAME.service is the loop. A Master fault names it. The Master implements the serve.`;\n');
  git('add', '-A');
  assert.deepEqual(oldPlannerNameLines(root), [
    'src/guide/setup.ts:1: A Master', 'src/guide/setup.ts:1: The Master',
    'web/pages/guide.tsx:2: the master',
  ]);
  assert.deepEqual(oldPlannerNameLines(), [], 'Help on this head calls the planner the Lead');
});

test('integration:product-review-cause-fixed-at-source — master status counts the group as its own review reason, so its fall after deploy shows', () => {
  const now = Date.parse('2026-11-27T13:00:00Z');
  const findings = [
    ['GY-3988', 'Settings -> Help (FAQ) — `web/pages/guide.tsx` still calls the planner "the master" in three FAQ answers'],
    ['GY-3994', "Settings → Help → Reference 'Setup prerequisites and options' — still says 'a Master fault naming the project', so Help still calls the planner the Master"],
  ];
  const items = findings.map(([key, finding], index) => ({ key, title: key, stage: 'build', stageEnteredAt: new Date(now).toISOString(), mergedAt: null, attempts: [],
    events: [{ kind: 'rework', at: new Date(now - (index + 1) * 60_000).toISOString(), binding: `abc${index}:verdict:review-codex`, reason: `${key}: the product review requested changes on abc: BLOCKING: ${finding}. The verdict stands.` }] }));
  assert.deepEqual(flowNumbers(items, 24, now).reviewReasons, [{ label: 'old planner name', count: 2 }]);
});
