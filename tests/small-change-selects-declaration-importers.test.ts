import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { changedDeclarations, changedExports, dependencyMap, listTestFiles, selectAffected } from '../scripts/ci-tests.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3750: test compute is the line's cost and trials are most of it. An item's trial of a change
// confined to function bodies or non-exported src code runs only the tests importing the exported
// names it reaches (directly or through re-exports), not every test reaching the file; a change to
// an exported signature or type, a test helper, a fixture, the install or anything outside src/
// selects as before. The reason line states both counts; the bound proof files are added after.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
}
const common = [
  'export interface Options { size: number }',
  'function clamp(value: number) { return Math.max(0, value); }',
  'export function widen(options: Options) { return clamp(options.size) + 1; }',
  'export function shrink(options: Options) { return options.size - 1; }',
  '',
].join('\n');
const project = {
  'package.json': '{}',
  'src/common.ts': common,
  'src/index.ts': "export * from './common.js';\n",
  'src/user.ts': "import { widen } from './common.js';\nexport const twice = (size: number) => widen({ size }) * 2;\n",
  'tests/helpers/make.ts': "import { shrink } from '../../src/common.js';\nexport const make = () => shrink({ size: 1 });\n",
  'fixtures/case.json': '{}\n',
  'tests/widen.test.ts': "import { widen } from '../src/common.js';\nwiden({ size: 1 });\n",
  'tests/hub.test.ts': "import { widen } from '../src/index.js';\nwiden({ size: 2 });\n",
  'tests/shrink.test.ts': "import { shrink } from '../src/common.js';\nshrink({ size: 1 });\n",
  'tests/user.test.ts': "import { twice } from '../src/user.js';\ntwice(1);\n",
  'tests/helper.test.ts': "import { make } from './helpers/make.js';\nmake();\n",
  'tests/proof.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('fixtures/case.json');\n",
};

test('unit:small-change-selects-declaration-importers — a body-only edit in a widely imported module selects only the importers of that declaration; an exported type edit, a test helper, a fixture and package.json select as today; both counts are stated', async () => {
  const root = await temporaryDirectory('declaration-importers');
  try {
    await write(root, project);
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
    const tests = listTestFiles(root), map = dependencyMap(root, tests);
    const trial = (files: Record<string, string>) => {
      const changed = Object.keys(files);
      return write(root, files).then(() => {
        const selection = selectAffected(changed, map, tests, changedDeclarations(changed, 'HEAD', root), changedExports(changed, 'HEAD', root));
        const today = selectAffected(changed, map, tests, changedDeclarations(changed, 'HEAD', root));
        git(root, 'checkout', '-q', '--', '.');
        return { selection, today: today.files };
      });
    };

    // A body edit of an exported function: its importers, through the re-exporting hub too; not the test reaching it through src/user.ts.
    const body = await trial({ 'src/common.ts': common.replace('clamp(options.size) + 1', 'clamp(options.size) + 2') });
    assert.deepEqual(body.today, ['tests/hub.test.ts', 'tests/user.test.ts', 'tests/widen.test.ts'], 'today: every test reaching widen');
    assert.deepEqual(body.selection.files, ['tests/hub.test.ts', 'tests/widen.test.ts']);
    assert.match(body.selection.reason, /^selected 2 of 3 reachable: the change is confined to function bodies or non-exported code of 1 file\(s\)$/);

    // A non-exported helper's edit selects the importers of the exported names using it.
    const helper = await trial({ 'src/common.ts': common.replace('Math.max(0, value)', 'Math.max(1, value)') });
    assert.deepEqual(helper.selection.files, ['tests/hub.test.ts', 'tests/widen.test.ts']);

    // An exported type or signature edit selects as today.
    const type = await trial({ 'src/common.ts': common.replace('size: number }', 'size: number; label?: string }') });
    assert.deepEqual(type.selection.files, type.today);
    assert.match(type.selection.reason, new RegExp(`^selected ${type.today.length} of ${type.today.length} reachable: `));
    const signature = await trial({ 'src/common.ts': common.replace('export function widen(options: Options)', 'export function widen(options: Options, by = 1)') });
    assert.deepEqual(signature.selection.files, signature.today);

    // A test helper, a fixture and package.json select as today.
    for (const files of [{ 'tests/helpers/make.ts': "import { shrink } from '../../src/common.js';\nexport const make = () => shrink({ size: 2 });\n" }, { 'fixtures/case.json': '{"a":1}\n' }] as Record<string, string>[]) {
      const outcome = await trial(files);
      assert.deepEqual(outcome.selection.files, outcome.today, Object.keys(files)[0]);
      assert.ok(outcome.today.length > 0);
    }
    const install = await trial({ 'package.json': '{"name":"x"}' });
    assert.equal(install.selection.mode, 'full');
    assert.deepEqual(install.selection.files, tests);

    // A body edit beside a file outside src/ selects as today.
    const mixed = await trial({ 'src/common.ts': common.replace('clamp(options.size) + 1', 'clamp(options.size) + 2'), 'fixtures/case.json': '{"b":1}\n' });
    assert.deepEqual(mixed.selection.files, mixed.today);
    assert.ok(mixed.selection.files.includes('tests/user.test.ts'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:small-change-selects-declaration-importers — the bound proof file always runs beside a narrowed selection', async () => {
  const { runMergeTrial } = await import('../src/merge-writer/executor.js');
  const { readFileSync } = await import('node:fs');
  const base = await temporaryDirectory('declaration-importers-trial');
  let listed: string[] = [], selectionEnv: Record<string, string | undefined> = {};
  const run = async (command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
    if (command === 'git' && args.includes('worktree') && args.includes('add')) {
      const worktree = args[args.indexOf('--detach') + 1]!;
      await mkdir(join(worktree, 'scripts'), { recursive: true });
      await writeFile(join(worktree, 'graphyard.json'), readFileSync(new URL('../graphyard.json', import.meta.url), 'utf8'));
    }
    if (command === 'node' && args[0] === 'scripts/ci-tests.mjs') { selectionEnv = options?.env ?? {}; return 'affected: selected 1 of 7 reachable: the change is confined to function bodies or non-exported code of 1 file(s)\ntests/widen.test.ts\n'; }
    if (command === 'node' && args.includes('tests/helpers/run-tests.ts')) {
      const group = (await (await import('node:fs/promises')).readFile(args[args.indexOf('--files-from') + 1]!, 'utf8')).split('\n').filter(Boolean);
      listed.push(...group);
      return ['TAP version 13', ...group.map((file, at) => `ok ${at + 1} - ${file}`), `1..${group.length}`, ''].join('\n');
    }
    return '';
  };
  try {
    await runMergeTrial({ root: base, base, mergeSha: 'a'.repeat(40), baseTip: 'b'.repeat(40), changedFiles: ['src/common.ts'], proofs: ['unit:widen-proof'], proofFiles: ['tests/proof.test.ts'], timeoutMs: 60_000, key: 'GY-1', temporaryRoots: [await temporaryDirectory('declaration-importers-tmp')], checkoutRoots: [], run: run as never, remove: async () => {}, cores: 2 });
    assert.equal(selectionEnv.GRAPHYARD_SELECTION_IMPORTERS, '1', "an item's trial asks for the narrowed selection");
    assert.deepEqual(listed.sort(), ['tests/proof.test.ts', 'tests/widen.test.ts'], 'the narrowed selection plus the bound proof file');
    const { readTestSelections } = await import('../src/merge-writer/test-selection.js');
    assert.deepEqual(readTestSelections(base).map(({ selected, reachable }) => ({ selected, reachable })), [{ selected: 1, reachable: 7 }], 'the trial records both counts for master status');
  } finally { await rm(base, { recursive: true, force: true }); }
});
