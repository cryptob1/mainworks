import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { gitRunnerFor, observeHead } from '../src/merge-writer/local-observation.js';
import { riskOf } from '../src/model-boundary/risk-class.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { extractChangedAssertions, validateAssertionRulings } from '../src/model/changed-assertions.js';
import { reviewPrompt } from '../src/reviewer.js';
import { recordReviewLaunch, recordReviewVerdict, tokenHashOf } from '../src/server/review-verdict.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { Engine } from '../src/engine.js';
import type { Services } from '../src/server/routes.js';
import type { Work } from '../src/model/work.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {});
});

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function initRepo(label: string, files: Record<string, string>): Promise<{ root: string; baseSha: string }> {
  const root = await temporaryDirectory(label);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  await writeFiles(root, files);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  return { root, baseSha };
}

test('e2e:weakened-test-is-caught — loosened assertion is classed sensitive, held from merge ahead of review, named in the reviewer request, and requires per-line ruling before approval', async () => {
  const { root, baseSha } = await initRepo('weakened-assertion', {
    'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
    'tests/math.test.ts': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.js';",
      "test('adds numbers', () => {",
      '  assert.equal(add(1, 2), 3);',
      '});',
      '',
    ].join('\n'),
  });

  // Candidate introduces a defect and loosens the existing assertion to make itself pass.
  git(root, 'checkout', '-b', 'graphyard/gy-777-1');
  await writeFiles(root, {
    'src/math.ts': 'export const add = (a: number, b: number) => a + b + 1;\n',
    'tests/math.test.ts': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.js';",
      "test('adds numbers', () => {",
      '  assert.ok(add(1, 2) > 0);',
      '});',
      '',
    ].join('\n'),
  });
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'loosen assertion');
  const headSha = git(root, 'rev-parse', 'HEAD');

  // 1. Observe the submitted head and assert it is classed sensitive and cannot merge ahead of review.
  const observation = await observeHead(gitRunnerFor(root), {
    head: headSha,
    base: 'main',
    branch: 'graphyard/gy-777-1',
    author: 'worker-1',
  });
  const store = await withDatabase('weakened-test-is-caught');
  cleanups.push(() => store.close());
  await store.init();
  const engine = new Engine(store);
  const work = (await engine.execute(
    { id: 'admin', role: 'admin' },
    'create',
    null,
    {
      title: 'Fix math',
      description: 'Update add',
      type: 'bug',
      criteria: [{ id: 'AC-1', text: 'add works', proofs: ['e2e:smoke'] }],
      policy: { checks: ['test'], review: true },
    },
    'create-1',
  )) as Work;
  work.ready = true;
  work.submission = { epoch: 1, pr: 1 };
  work.candidate = { ...observation.candidate, pr: 1 };
  work.observation = { ...observation, candidate: { ...observation.candidate, pr: 1 } };
  work.implementers = ['worker-1'];
  assert.equal(riskOf(work).risk, 'sensitive');
  assert.ok(riskOf(work).reasons.some(r => r.includes('tests/math.test.ts')));

  const evalResult = evaluate(work, [work], new Date());
  const reviewGate = evalResult.gates.find(g => g.name === 'review')!;
  assert.equal(reviewGate.passed, false, 'weakened test cannot pass review gate ahead of review');
  assert.ok(reviewGate.reasons.some(r => r.includes('tests/math.test.ts')));

  // 2. Extract changed assertions from the diff and assert the reviewer's request names the changed line.
  const diff = git(root, 'diff', '--no-color', '--no-ext-diff', baseSha, headSha);
  const changed = extractChangedAssertions(diff);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.path, 'tests/math.test.ts');
  assert.equal(changed[0]!.line, 5);
  assert.match(changed[0]!.before, /assert\.equal\(add\(1, 2\), 3\)/);
  assert.match(changed[0]!.after ?? '', /assert\.ok\(add\(1, 2\) > 0\)/);

  const prompt = reviewPrompt(
    { repository: 'owner/repo' },
    { key: work.key, pr: 1, sha: headSha, baseSha, policyRevision: work.policyRevision },
    undefined,
    undefined,
    work.criteria,
    undefined,
    observation.files,
    null,
    null,
    null,
    { head: headSha, baseTip: baseSha, changedAssertions: changed },
  );
  assert.ok(prompt.includes('tests/math.test.ts:5'), 'reviewer prompt names the changed assertion path and line');
  assert.ok(prompt.includes('assert.equal(add(1, 2), 3)'), 'reviewer prompt quotes the original assertion');
  assert.ok(prompt.includes('kept meaning') && prompt.includes('weakened'), 'reviewer prompt requires ruling');

  // 3. Server verdict enforcement: APPROVE without ruling or with "weakened" is refused; ruling "kept meaning" succeeds; REQUEST_CHANGES succeeds.
  await store.pool.query('UPDATE work_items SET document=$1 WHERE id=$2', [JSON.stringify(work), work.id]);
  const services = { engine } as unknown as Services;
  const token = randomBytes(32).toString('hex');
  await recordReviewLaunch(
    services,
    { id: 'coordinator', role: 'coordinator' },
    work.key,
    {
      reviewer: 'reviewer-1',
      head: headSha,
      baseTip: baseSha,
      tokenHash: tokenHashOf(token),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      changedAssertions: changed,
    },
    'launch-1',
  );

  // Unruled APPROVE must fail
  await assert.rejects(
    () =>
      recordReviewVerdict(
        services,
        { id: 'reviewer-1', role: 'reader' },
        work.key,
        { event: 'APPROVE', body: `Head ${headSha} vs ${baseSha}. Looks good.\nAC-1 met — add works.`, sha: headSha, token },
        'verdict-unruled',
      ),
    /tests\/math\.test\.ts:5/,
  );

  // APPROVE when ruled weakened must fail
  await assert.rejects(
    () =>
      recordReviewVerdict(
        services,
        { id: 'reviewer-1', role: 'reader' },
        work.key,
        { event: 'APPROVE', body: `Head ${headSha} vs ${baseSha}.\ntests/math.test.ts:5 — weakened: accepts any positive number\nAC-1 met — add works.`, sha: headSha, token },
        'verdict-weakened-approve',
      ),
    /weakened/i,
  );

  // Pure validator accepts kept meaning; also extracts changed expectations from E2E case JSON diffs.
  assert.equal(
    validateAssertionRulings('tests/math.test.ts:5 — kept meaning: equivalent check', changed),
    null,
  );
  const e2eDiff = [
    'diff --git a/e2e/cases/smoke.json b/e2e/cases/smoke.json',
    '--- a/e2e/cases/smoke.json',
    '+++ b/e2e/cases/smoke.json',
    '@@ -9,1 +9,1 @@',
    '-    { "kind": "http", "status": 200, "expect": [{ "path": "healthy", "equals": true }] }',
    '+    { "kind": "http", "status": 200 }',
  ].join('\n');
  const e2eChanged = extractChangedAssertions(e2eDiff);
  assert.equal(e2eChanged.length, 1);
  assert.equal(e2eChanged[0]!.path, 'e2e/cases/smoke.json');
  assert.equal(e2eChanged[0]!.line, 9);

  // REQUEST_CHANGES ruling it weakened succeeds
  const reqChanges = await recordReviewVerdict(
    services,
    { id: 'reviewer-1', role: 'reader' },
    work.key,
    { event: 'REQUEST_CHANGES', body: `Head ${headSha} vs ${baseSha}.\ntests/math.test.ts:5 — weakened\nBLOCKING: tests/math.test.ts:5 — assertion was loosened\nAC-1 unmet — the add check was loosened.`, sha: headSha, token },
    'verdict-request-changes',
  );
  assert.equal((reqChanges as { state: string }).state, 'CHANGES_REQUESTED');
});

test('e2e:weakened-test-is-caught — merge trial uses base commit scripts/ci-tests.mjs and timing baseline unless approved, and still runs candidate new tests', async () => {
  const { root, baseSha } = await initRepo('trial-base-selector', {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: {} }, null, 2) + '\n',
    'graphyard.json': JSON.stringify({
      delivery: {
        mergeGate: {
          preMerge: [
            {
              check: 'test',
              command: 'node tests/helpers/run-tests.mjs',
              source: 'script',
              reason: 'Run selected tests',
              selection: {
                command: 'node scripts/ci-tests.mjs affected',
                pattern: '^tests/[\\w./-]+\\.test\\.mjs$',
                durations: 'tests/helpers/timing-baseline.json',
              },
            },
          ],
          perCandidate: [],
        },
      },
    }, null, 2) + '\n',
    'tests/helpers/run-tests.mjs': String.raw`import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const listFile = args[args.indexOf('--files-from') + 1];
const durFile = args[args.indexOf('--durations') + 1];
const files = readFileSync(listFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const records = [];
let failed = false;
for (const f of files) {
  try { execFileSync(process.execPath, [f], { stdio: 'inherit' }); records.push(JSON.stringify({ file: f, passed: true, durationMs: 10 })); }
  catch { failed = true; records.push(JSON.stringify({ file: f, passed: false, durationMs: 10 })); }
}
if (durFile) writeFileSync(durFile, records.join('\n') + '\n');
process.exit(failed ? 1 : 0);
`,
    'tests/helpers/timing-baseline.json': JSON.stringify({ files: { 'tests/existing.test.mjs': 500 } }, null, 2) + '\n',
    'scripts/ci-tests.mjs': String.raw`import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tests = readdirSync(join(root, 'tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => 'tests/' + f);
console.log(tests.join('\n'));
`,
    'src/value.mjs': 'export const value = 1;\n',
    'tests/existing.test.mjs': [
      "import assert from 'node:assert/strict';",
      "import { value } from '../src/value.mjs';",
      'assert.equal(value, 1);',
      '',
    ].join('\n'),
  });

  // Candidate breaks src/value.mjs, tampers with scripts/ci-tests.mjs to select NOTHING, and adds a new test.
  git(root, 'checkout', '-b', 'graphyard/gy-778-1');
  await writeFiles(root, {
    'src/value.mjs': 'export const value = 999;\n',
    'scripts/ci-tests.mjs': 'console.log("");\n',
    'tests/new-feature.test.mjs': 'import assert from "node:assert/strict"; assert.equal(2 + 2, 4);\n',
  });
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'tamper selector and break existing test');
  const headSha = git(root, 'rev-parse', 'HEAD');

  // Strip the Docker container wrapper in sandboxed test runs while executing every git/node command for real.
  const gitShows: string[] = [];
  const directRun: ChildRun = (command, args, options) => {
    if (command === 'git' && args.includes('show')) gitShows.push(args[args.indexOf('show') + 1] ?? '');
    const { wrapper: _wrapper, ...rest } = (options ?? {}) as Record<string, unknown>;
    return defaultChildRun(command, args, rest as Parameters<ChildRun>[2]);
  };

  const trialRoot = await temporaryDirectory('trial-base-selector-worktrees');
  cleanups.push(() => rm(trialRoot, { recursive: true, force: true }));

  // Unapproved: uses BASE commit's scripts/ci-tests.mjs and timing-baseline.json -> selects both existing.test.mjs (fails!) and new-feature.test.mjs (runs!).
  const unapproved = await runTrial({
    root,
    base: trialRoot,
    mergeSha: headSha,
    baseTip: baseSha,
    changedFiles: ['src/value.mjs', 'scripts/ci-tests.mjs', 'tests/new-feature.test.mjs'],
    timeoutMs: 60_000,
    run: directRun,
    secretScan: false,
    retries: 0,
  });
  assert.ok(unapproved.tests.failed.includes('tests/existing.test.mjs'), `base selector catches the broken existing test despite candidate tampering: ${unapproved.tests.failed} | log: ${unapproved.logTail}`);
  assert.equal(unapproved.tests.files, 2, 'both existing and candidate new test were selected');
  assert.ok(gitShows.includes(`${baseSha}:scripts/ci-tests.mjs`), 'unapproved trial reads scripts/ci-tests.mjs from baseTip');
  assert.ok(gitShows.includes(`${baseSha}:tests/helpers/timing-baseline.json`), 'unapproved trial reads timing-baseline.json from baseTip');

  // Approved: uses CANDIDATE's scripts/ci-tests.mjs -> selects nothing and passes.
  gitShows.length = 0;
  const approved = await runTrial({
    root,
    base: trialRoot,
    mergeSha: headSha,
    baseTip: baseSha,
    changedFiles: ['src/value.mjs', 'scripts/ci-tests.mjs', 'tests/new-feature.test.mjs'],
    timeoutMs: 60_000,
    run: directRun,
    secretScan: false,
    retries: 0,
    selectorApproved: true,
  });
  assert.deepEqual(approved.tests.failed, [], 'approved selector change takes effect');
  assert.equal(approved.tests.files, 0);
  assert.ok(!gitShows.includes(`${baseSha}:scripts/ci-tests.mjs`), 'approved trial uses candidate scripts/ci-tests.mjs');
});
