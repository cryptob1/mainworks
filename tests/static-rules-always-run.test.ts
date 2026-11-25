import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { repositoryRoot } from '../scripts/ci-tests.mjs';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3826: fast static rule tests always run in item merge trials and the release check,
// whatever narrow selection the change otherwise picks.

const staticRuleTests = [
  'tests/architecture.test.ts',
  'tests/architecture-pinned.test.ts',
  'tests/barrel-imports.test.ts',
  'tests/import-cycles.test.ts',
  'tests/no-old-name.test.ts',
  'tests/knip-clean.test.ts',
];

const identity = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...identity },
  }).trim();

function sharedCheckout(source: string, root: string) {
  const head = git(source, 'rev-parse', 'HEAD');
  git(root, 'init', '-q');
  writeFileSync(join(root, '.git/objects/info/alternates'), `${git(source, 'rev-parse', '--path-format=absolute', '--git-path', 'objects')}\n`);
  git(root, 'checkout', '-q', '--detach', head);
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

const selectIn = (cwd: string, changed: string[], env: Record<string, string | undefined>) => {
  const out = execFileSync(process.execPath, ['scripts/ci-tests.mjs', 'affected', ...changed], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { out, files: out.split('\n').filter(line => /^tests\/.+\.test\.ts$/.test(line)) };
};

test('integration:static-rules-always-run — a one-file trial and the release check both select all six static rule tests, and an unallowlisted git push in an unrelated source file fails its trial on git-network-door', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('static-rules-repo');
  const trials = await temporaryDirectory('static-rules-trials');
  try {
    sharedCheckout(repositoryRoot, root);
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'));
    // Test this checkout's selector, committed or not; on the base tip this is the unfixed selector.
    await writeFiles(root, { 'scripts/ci-tests.mjs': await readFile(join(repositoryRoot, 'scripts/ci-tests.mjs'), 'utf8') });
    if (git(root, 'status', '--porcelain', 'scripts/ci-tests.mjs')) {
      git(root, 'add', 'scripts/ci-tests.mjs');
      git(root, 'commit', '-qm', 'selector under test');
    }
    const base = git(root, 'rev-parse', 'HEAD');
    const source = 'src/model/timing-companion.ts';
    const original = await readFile(join(root, source), 'utf8');

    // AC-1: a one-file body edit selects all six static rule tests besides its own selection,
    // in both an item trial (GRAPHYARD_SELECTION_BASE + GRAPHYARD_SELECTION_IMPORTERS) and the
    // release check (with base and without base, no GRAPHYARD_SELECTION_IMPORTERS).
    await writeFiles(root, { [source]: original.replace('testFile(path) && ', 'testFile(path) === true && ') });
    git(root, 'add', source);
    git(root, 'commit', '-qm', 'unrelated one-file edit');

    const itemTrial = selectIn(root, [source], { GRAPHYARD_SELECTION_BASE: base, GRAPHYARD_SELECTION_IMPORTERS: '1' });
    const gateWithBase = selectIn(root, [source], { GRAPHYARD_SELECTION_BASE: base, GRAPHYARD_SELECTION_IMPORTERS: undefined });
    const gateNoBase = selectIn(root, [source], { GRAPHYARD_SELECTION_BASE: undefined, GRAPHYARD_SELECTION_IMPORTERS: undefined });

    for (const [label, selection] of [
      ['item trial', itemTrial],
      ['release check (with base)', gateWithBase],
      ['release check (no base)', gateNoBase],
    ] as const) {
      assert.ok(selection.out.startsWith('affected:'), `${label}: ${selection.out.split('\n')[0]}`);
      for (const rule of staticRuleTests) {
        assert.ok(selection.files.includes(rule), `${label} must select ${rule}`);
      }
      assert.ok(selection.files.some(file => !staticRuleTests.includes(file)), `${label} also keeps its own selection`);
    }

    // AC-2: adding a git push outside the allowlist to that same unrelated source file fails its
    // merge trial on tests/architecture.test.ts (git-network-door).
    git(root, 'checkout', '-q', '--detach', base);
    await writeFiles(root, {
      [source]: original.replace(
        'export const timedTestFile = (path: string) => testFile(path) && /^tests\\/[^/]+\\.test\\.ts$/.test(path);',
        "export const timedTestFile = (path: string) => { void ['push', 'origin', 'main']; return testFile(path) && /^tests\\/[^/]+\\.test\\.ts$/.test(path); };",
      ),
    });
    git(root, 'add', source);
    git(root, 'commit', '-qm', 'unallowlisted git push in unrelated source file');
    const mergeSha = git(root, 'rev-parse', 'HEAD');

    const run: ChildRun = (command, args, options) =>
      defaultChildRun(command, args, {
        ...options,
        wrapper: undefined,
        ...(command === 'git' ? { env: { ...process.env, ...identity, ...options?.env } } : {}),
      });
    const verdict = await runTrial({
      root,
      base: trials,
      key: 'GY-3826-door',
      mergeSha,
      baseTip: base,
      changedFiles: [source],
      timeoutMs: 240_000,
      run,
      secretScan: false,
      remote: { hosts: [] },
      retries: 0,
      cores: 4,
    });
    assert.equal(verdict.build, 'pass', verdict.logTail);
    assert.ok(verdict.tests.failed.includes('tests/architecture.test.ts'), `expected tests/architecture.test.ts to fail; failed=${JSON.stringify(verdict.tests.failed)}\n${verdict.logTail}`);
    assert.match(verdict.logTail, /git-network-door/, 'trial failure names the git-network-door rule');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(trials, { recursive: true, force: true });
  }
});

test('e2e:static-rules-always-run — on a running test install a one-file trial records the static rule files among its selected tests', { timeout: 240_000 }, async () => {
  const selectorText = await readFile(join(repositoryRoot, 'scripts/ci-tests.mjs'), 'utf8');
  const runnerScript = `const { appendFileSync, readFileSync } = require('node:fs');
const after = name => process.argv[process.argv.indexOf(name) + 1];
const files = readFileSync(after('--files-from'), 'utf8').split('\\n').filter(Boolean);
console.log('TAP version 13');
let n = 0;
for (const file of files) {
  n++;
  const name = file === 'tests/proof.test.ts' ? 'unit:declared holds' : 'case ' + file;
  console.log('# Subtest: ' + file + '\\n    ok 1 - ' + name + '\\nok ' + n + ' - ' + file);
  appendFileSync(after('--durations'), JSON.stringify({ file, durationMs: 1, passed: true }) + '\\n');
}
console.log('1..' + n);
`;
  const extra: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'static-rules-fixture', scripts: { build: 'node --eval 0' } }),
    'scripts/ci-tests.mjs': selectorText,
    'runner.cjs': runnerScript,
    'src/unrelated.ts': 'export function unrelated(n: number) { return n + 1; }\n',
    'tests/unrelated.test.ts': "import { unrelated } from '../src/unrelated.js';\nvoid unrelated(1);\n",
    'tests/proof.test.ts': '// unit:declared\n',
    'graphyard.json': JSON.stringify({
      e2e: { pendingOutcomes: 'non-blocking' },
      featureMap: [{ name: 'Home', url: '/', traps: [] }],
      gate: { core: ['smoke'] },
      delivery: {
        mode: 'local',
        cases: { fixture: 'site', smoke: 'site' },
        applications: [{ id: 'site', kind: 'static', directory: 'site', build: null }],
        mergeGate: {
          perCandidate: [],
          preMerge: [{
            check: 'test',
            command: 'node runner.cjs',
            source: 'script',
            reason: 'fixture',
            selection: { command: 'node scripts/ci-tests.mjs affected', pattern: '^tests/[\\w./-]+\\.test\\.ts$' },
          }],
        },
      },
    }),
  };
  for (const rule of staticRuleTests) extra[rule] = '// static rule test\n';

  const priorNodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = [join(repositoryRoot, 'node_modules'), priorNodePath].filter(Boolean).join(':');
  const where = await pipelineWorld('static-rules-always-run', extra);
  try {
    const loop = worldLoop(where, { gate: false });
    const change = await where.submit('One-file unrelated change', {
      'src/unrelated.ts': 'export function unrelated(n: number) { return n + 2; }\n',
    });
    await cycleUntil(loop, `${change.key} merges`, async () => (await where.work()).find(item => item.id === change.id)?.stage === 'done');

    const { rows } = await where.store.pool.query(
      "SELECT payload FROM events WHERE work_id = $1 AND kind = 'merge.trial' ORDER BY seq DESC LIMIT 1",
      [change.id],
    );
    assert.equal(rows.length, 1, 'merge.trial event recorded');
    const files: string[] = rows[0]!.payload.files ?? [];
    assert.ok(files.includes('tests/unrelated.test.ts'), `selected tests include own test: ${JSON.stringify(files)}`);
    for (const rule of staticRuleTests) {
      assert.ok(files.includes(rule), `recorded trial files must include ${rule}: ${JSON.stringify(files)}`);
    }
  } finally {
    if (priorNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = priorNodePath;
    await where.close();
  }
});
