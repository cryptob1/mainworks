import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { changedDeclarations, changedExports, dependencyMap, listTestFiles, repositoryRoot, selectAffected } from '../scripts/ci-tests.mjs';
import { allowlist, audit } from './architecture.test.js';
import { cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git } from './helpers/git-repo.js';

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


async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

test('integration:static-rules-always-run — a one-file trial and the release check both select all six static rule tests, and an unallowlisted git push in an unrelated source file fails its trial on git-network-door', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('static-rules-repo');
  try {
    const source = 'src/unrelated.ts';
    const seeded: Record<string, string> = {
      [source]: 'export function unrelated(n: number) { return n + 1; }\n',
      'tests/unrelated.test.ts': "import { unrelated } from '../src/unrelated.js';\nvoid unrelated(1);\n",
      'tests/other.test.ts': '// unrelated test so affected mode stays narrow\n',
    };
    for (const rule of staticRuleTests) seeded[rule] = '// static rule test\n';

    git(root, 'init', '-q');
    await writeFiles(root, seeded);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');

    // AC-1: a one-file body edit selects all six static rule tests besides its own selection,
    // in both an item trial (GRAPHYARD_SELECTION_BASE + GRAPHYARD_SELECTION_IMPORTERS) and the
    // release check (with base and without base, no GRAPHYARD_SELECTION_IMPORTERS).
    await writeFiles(root, { [source]: 'export function unrelated(n: number) { return n + 2; }\n' });
    git(root, 'add', source);
    git(root, 'commit', '-qm', 'unrelated one-file edit');

    const tests = listTestFiles(root);
    const map = dependencyMap(root, tests);
    const declarations = changedDeclarations([source], base, root);
    const exports = changedExports([source], base, root);

    const itemTrial = selectAffected([source], map, tests, declarations, exports);
    const gateWithBase = selectAffected([source], map, tests, declarations);
    const gateNoBase = selectAffected([source], map, tests);

    for (const [label, selection] of [
      ['item trial', itemTrial],
      ['release check (with base)', gateWithBase],
      ['release check (no base)', gateNoBase],
    ] as const) {
      assert.equal(selection.mode, 'affected', `${label}: ${selection.mode}: ${selection.reason}`);
      for (const rule of staticRuleTests) {
        assert.ok(selection.files.includes(rule), `${label} must select ${rule}`);
      }
      assert.ok(selection.files.some(file => !staticRuleTests.includes(file)), `${label} also keeps its own selection`);
      assert.ok(selection.files.includes('tests/unrelated.test.ts'), `${label} selects the changed file's own test`);
      assert.ok(!selection.files.includes('tests/other.test.ts'), `${label} stays narrow and skips unrelated tests`);
    }

    // AC-2: adding a git push outside the allowlist to that same unrelated source file is refused
    // by tests/architecture.test.ts (git-network-door), which the selection above runs.
    const seededWithPush = "export function unrelated(n: number) { void ['push', 'origin', 'main']; return n + 1; }\n";
    assert.ok(!Object.hasOwn(allowlist, source), `${source} is outside the git-network-door allowlist`);
    const { refusals } = audit(new Map([[source, seededWithPush]]), {});
    assert.equal(refusals.length, 1, `expected one git-network-door refusal; got ${JSON.stringify(refusals)}`);
    assert.match(refusals[0], /git-network-door/, 'refusal names the git-network-door rule');
    assert.match(refusals[0], /src\/unrelated\.ts:1\b.*push/, 'refusal names the file, line and subcommand');
  } finally {
    await rm(root, { recursive: true, force: true });
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
