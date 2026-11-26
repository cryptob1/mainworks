import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3914 AC-1: The loop never writes inside the candidate's tree during selection: the base
// selector script is written to and run from the trial's temporary directory. With the selector
// path committed as a symlink to a file outside the tree, a trial leaves that file's content,
// owner and mode unchanged and selection still runs. Two trials sharing a kept tree select
// correctly at the same time.

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => {});
});

const identity = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

const writeFiles = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
};

const baseFixtureFiles = {
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
  'scripts/ci-tests.mjs': String.raw`import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const changed = process.argv.slice(3);
const all = readdirSync(join(root, 'tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => 'tests/' + f);
const picked = changed.length ? all.filter(f => changed.some(c => f.includes(c.replace(/^src\/|\.mjs$/g, '')))) : all;
console.log((picked.length ? picked : all).join('\n'));
`,
  'src/alpha.mjs': 'export const alpha = 1;\n',
  'src/beta.mjs': 'export const beta = 2;\n',
  'tests/alpha.test.mjs': "import assert from 'node:assert/strict'; import { alpha } from '../src/alpha.mjs'; assert.equal(alpha, 1);\n",
  'tests/beta.test.mjs': "import assert from 'node:assert/strict'; import { beta } from '../src/beta.mjs'; assert.equal(beta, 2);\n",
};

const directRun: ChildRun = (command, args, options) => {
  const { wrapper: _wrapper, ...rest } = (options ?? {}) as Record<string, unknown>;
  return defaultChildRun(command, args, rest as Parameters<ChildRun>[2]);
};

test('integration:selector-script-never-written-into-the-candidate-tree — symlinked selector leaves outside file unchanged and runs base selector from temp dir', async () => {
  const root = await temporaryDirectory('selector-symlink-repo');
  const outsideDir = await temporaryDirectory('selector-outside-target');
  const trialRoot = await temporaryDirectory('selector-symlink-trials');
  cleanups.push(
    () => rm(root, { recursive: true, force: true }),
    () => rm(outsideDir, { recursive: true, force: true }),
    () => rm(trialRoot, { recursive: true, force: true }),
  );

  const outsideFile = join(outsideDir, 'precious.txt');
  const originalContent = 'DO NOT OVERWRITE THIS HOST FILE\n';
  await writeFile(outsideFile, originalContent, 'utf8');
  await chmod(outsideFile, 0o640);
  const beforeStat = await stat(outsideFile);

  git(root, 'init', '-q', '-b', 'main');
  await writeFiles(root, baseFixtureFiles);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');

  // Candidate replaces scripts/ci-tests.mjs with a symlink to outsideFile and breaks src/alpha.mjs.
  git(root, 'checkout', '-q', '-b', 'candidate');
  await rm(join(root, 'scripts/ci-tests.mjs'));
  await symlink(outsideFile, join(root, 'scripts/ci-tests.mjs'));
  await writeFile(join(root, 'src/alpha.mjs'), 'export const alpha = 999;\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'symlink selector to outside file');
  const headSha = git(root, 'rev-parse', 'HEAD');

  let observedOutsideDuringSelection: string | null = null;
  let selectionScriptArg: string | null = null;
  const spyRun: ChildRun = async (command, args, options) => {
    if (command === 'node' && args.some(arg => arg.endsWith('ci-tests.mjs'))) {
      selectionScriptArg = args.find(arg => arg.endsWith('ci-tests.mjs')) ?? null;
      observedOutsideDuringSelection = await readFile(outsideFile, 'utf8');
    }
    return directRun(command, args, options);
  };

  const result = await runTrial({
    root,
    base: trialRoot,
    mergeSha: headSha,
    baseTip: baseSha,
    changedFiles: ['src/alpha.mjs', 'scripts/ci-tests.mjs'],
    timeoutMs: 60_000,
    run: spyRun,
    secretScan: false,
    retries: 0,
  });

  // Outside file must never have been modified — not even transiently during selection.
  assert.equal(observedOutsideDuringSelection, originalContent, 'outside symlink target was untouched while selection ran');
  assert.equal(await readFile(outsideFile, 'utf8'), originalContent, 'outside symlink target content unchanged');
  const afterStat = await stat(outsideFile);
  assert.equal(afterStat.uid, beforeStat.uid, 'outside file owner uid unchanged');
  assert.equal(afterStat.gid, beforeStat.gid, 'outside file owner gid unchanged');
  assert.equal(afterStat.mode, beforeStat.mode, 'outside file mode unchanged');

  // Selection ran from a temporary directory, not from inside the worktree's relative path.
  assert.ok(selectionScriptArg && selectionScriptArg !== 'scripts/ci-tests.mjs', `base selector ran from temporary directory, got: ${selectionScriptArg}`);

  // Base selector still selected tests/alpha.test.mjs and caught the broken src/alpha.mjs.
  assert.ok(result.tests.failed.includes('tests/alpha.test.mjs'), `expected tests/alpha.test.mjs to fail, got: ${JSON.stringify(result.tests)}`);
});

test('integration:selector-script-never-written-into-the-candidate-tree — two concurrent trials sharing a kept tree select without racing or writing into the tree', async () => {
  const root = await temporaryDirectory('selector-concurrent-repo');
  const trialRoot = await temporaryDirectory('selector-concurrent-trials');
  cleanups.push(
    () => rm(root, { recursive: true, force: true }),
    () => rm(trialRoot, { recursive: true, force: true }),
  );

  git(root, 'init', '-q', '-b', 'main');
  await writeFiles(root, {
    ...baseFixtureFiles,
    'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }) + '\n',
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');

  // Candidate tampers with scripts/ci-tests.mjs so it prints nothing; unapproved trials must use base selector.
  git(root, 'checkout', '-q', '-b', 'candidate');
  await writeFile(join(root, 'scripts/ci-tests.mjs'), 'console.log("");\n', 'utf8');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'tamper selector');
  const headSha = git(root, 'rev-parse', 'HEAD');

  // Coordinate the two trials so both enter selection simultaneously on the shared kept tree.
  let entered = 0;
  let releaseBoth!: () => void;
  const bothEntered = new Promise<void>(resolve => { releaseBoth = resolve; });
  const scriptPaths: string[] = [];
  const worktreeSelectorStates: string[] = [];

  const barrierRun: ChildRun = async (command, args, options) => {
    if (command === 'node' && args.some(arg => arg.endsWith('ci-tests.mjs'))) {
      const scriptArg = args.find(arg => arg.endsWith('ci-tests.mjs'))!;
      scriptPaths.push(scriptArg);
      const cwd = (options as { cwd?: string } | undefined)?.cwd;
      if (cwd) {
        worktreeSelectorStates.push(await readFile(join(cwd, 'scripts/ci-tests.mjs'), 'utf8'));
      }
      entered++;
      if (entered >= 2) releaseBoth();
      else await Promise.race([bothEntered, new Promise(r => setTimeout(r, 5_000))]);
    }
    return directRun(command, args, options);
  };

  // Warm the kept tree once so both concurrent trials share the exact same kept worktree.
  await runTrial({
    root,
    base: trialRoot,
    mergeSha: headSha,
    baseTip: baseSha,
    changedFiles: ['src/alpha.mjs'],
    timeoutMs: 60_000,
    run: directRun,
    secretScan: false,
    caches: true,
    retries: 0,
  });

  const [first, second] = await Promise.all([
    runTrial({
      root,
      base: trialRoot,
      mergeSha: headSha,
      baseTip: baseSha,
      changedFiles: ['src/alpha.mjs'],
      timeoutMs: 60_000,
      run: barrierRun,
      secretScan: false,
      caches: true,
      retries: 0,
    }),
    runTrial({
      root,
      base: trialRoot,
      mergeSha: headSha,
      baseTip: baseSha,
      changedFiles: ['src/beta.mjs'],
      timeoutMs: 60_000,
      run: barrierRun,
      secretScan: false,
      caches: true,
      retries: 0,
    }),
  ]);

  assert.equal(first.build, 'pass');
  assert.equal(second.build, 'pass');
  assert.deepEqual(first.tests.failed, []);
  assert.deepEqual(second.tests.failed, []);
  assert.equal(first.tests.passed, 1, 'first concurrent trial selected and passed alpha');
  assert.equal(second.tests.passed, 1, 'second concurrent trial selected and passed beta');
  assert.equal(scriptPaths.length, 2, 'both trials ran selection');
  assert.notEqual(scriptPaths[0], scriptPaths[1], 'each concurrent trial ran its own temporary selector copy');
  for (const content of worktreeSelectorStates) {
    assert.equal(content, 'console.log("");\n', 'candidate tree selector file was never overwritten');
  }
});
