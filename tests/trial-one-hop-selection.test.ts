import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedDeclarations, changedExports, dependencyMap, listTestFiles, repositoryRoot, selectAffected } from '../scripts/ci-tests.mjs';
import { masterStatusReport } from '../src/cli/master-status.js';
import { recordTestSelection, selectionCounts } from '../src/merge-writer/test-selection.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import { cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git } from './helpers/git-repo.js';

// GY-3866: an item's trial selects only the tests importing a changed file directly (one hop), its
// bound proofs and the static rules; the release check's sweep still runs the transitive importers.

const staticRuleTests = ['tests/architecture.test.ts', 'tests/architecture-pinned.test.ts', 'tests/barrel-imports.test.ts', 'tests/import-cycles.test.ts', 'tests/no-old-name.test.ts', 'tests/knip-clean.test.ts'];
async function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
}
// An exported signature change, which the body-only narrowing (GY-3750) leaves to the full reachable selection.
const core = 'export function core(n: number) { return n + 1; }\n';
const changedCore = 'export function core(n: number, by = 1) { return n + by; }\n';
const project: Record<string, string> = {
  'src/core.ts': core,
  'src/mid.ts': "import { core } from './core.js';\nexport const mid = (n: number) => core(n) * 2;\n",
  'tests/direct.test.ts': "import { core } from '../src/core.js';\ncore(1);\n",
  'tests/transitive.test.ts': "import { mid } from '../src/mid.js';\nmid(1);\n",
  'tests/other.test.ts': '// unrelated\n',
  ...Object.fromEntries(staticRuleTests.map(rule => [rule, '// static rule test\n'])),
};

test('integration:trial-one-hop-selection — an item trial selects the direct importer and static rules, not the transitive importer; the release check is unchanged; master status shows the median share of all tests before and after', async () => {
  const root = await temporaryDirectory('one-hop-selection');
  try {
    await write(root, { 'package.json': '{}', ...project });
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
    const base = git(root, 'rev-parse', 'HEAD');
    await write(root, { 'src/core.ts': changedCore });
    git(root, 'commit', '-qam', 'change');
    const changed = ['src/core.ts'], tests = listTestFiles(root), map = dependencyMap(root, tests);
    const declarations = changedDeclarations(changed, base, root, 'HEAD');

    const trial = selectAffected(changed, map, tests, declarations, changedExports(changed, base, root, 'HEAD'));
    assert.ok(trial.files.includes('tests/direct.test.ts'), `the direct importer runs: ${trial.files}`);
    assert.ok(!trial.files.includes('tests/transitive.test.ts'), `the transitive importer is left to the release check: ${trial.files}`);
    assert.ok(!trial.files.includes('tests/other.test.ts'));
    for (const rule of staticRuleTests) assert.ok(trial.files.includes(rule), `${rule} always runs`);
    assert.deepEqual(selectionCounts(trial.reason.split('\n')[0]!), { selected: 7, reachable: 8, oneHop: true }, trial.reason);

    // The release check (no importer narrowing) still selects the transitive importer, with or without a base.
    for (const gate of [selectAffected(changed, map, tests, declarations), selectAffected(changed, map, tests)]) {
      assert.ok(gate.files.includes('tests/transitive.test.ts') && gate.files.includes('tests/direct.test.ts'), gate.files.join(', '));
    }
  } finally { await rm(root, { recursive: true, force: true }); }

  // AC-2: the median share of all test files, over trials before the change and after it.
  const install = await temporaryDirectory('one-hop-status');
  git(install, 'init', '-q', '-b', 'main');
  const credentials = await temporaryDirectory('one-hop-credentials'), credentialFile = join(credentials, 'coordinator.token');
  writeFileSync(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({
    version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/one-hop', baseBranch: 'main', hostId: 'coord-a', masterAgentName: 'graphyard-master-one-hop', workers: [],
    run: { worktreeRoot: await temporaryDirectory('one-hop-wt') },
  }) as MasterConfig;
  await recordTestSelection(install, { selected: 40, reachable: 50, all: 100, key: 'GY-1' });
  await recordTestSelection(install, { selected: 60, reachable: 80, all: 100, key: 'GY-2' });
  await recordTestSelection(install, { selected: 10, reachable: 50, all: 100, key: 'GY-3', oneHop: true });
  const report = await masterStatusReport(install, config, async () => { throw new TypeError('fetch failed'); }, async () => '') as any;
  assert.deepEqual(report.testSelection.medianShareOfAll, { before: '40%', after: '10%' });
});

test('e2e:trial-one-hop-selection — on a running test install a one-file change selects only its direct importers, its proofs and the static rules', { timeout: 300_000 }, async () => {
  const runner = `const { appendFileSync, readFileSync } = require('node:fs');
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
    ...project,
    'package.json': JSON.stringify({ name: 'one-hop-fixture', scripts: { build: 'node --eval 0' } }),
    'scripts/ci-tests.mjs': await readFile(join(repositoryRoot, 'scripts/ci-tests.mjs'), 'utf8'),
    'runner.cjs': runner,
    'tests/proof.test.ts': '// unit:declared\n',
    'graphyard.json': JSON.stringify({
      e2e: { pendingOutcomes: 'non-blocking' },
      featureMap: [{ name: 'Home', url: '/', traps: [] }],
      gate: { core: ['smoke'] },
      delivery: {
        mode: 'local',
        cases: { fixture: 'site', smoke: 'site' },
        applications: [{ id: 'site', kind: 'static', directory: 'site', build: null }],
        mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node runner.cjs', source: 'script', reason: 'fixture', selection: { command: 'node scripts/ci-tests.mjs affected', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] },
      },
    }),
  };
  const priorNodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = [join(repositoryRoot, 'node_modules'), priorNodePath].filter(Boolean).join(':');
  const where = await pipelineWorld('trial-one-hop-selection', extra);
  try {
    const loop = worldLoop(where, { gate: false });
    const change = await where.submit('One-file signature change', { 'src/core.ts': changedCore });
    await cycleUntil(loop, `${change.key} merges`, async () => (await where.work()).find(item => item.id === change.id)?.stage === 'done');
    const { rows } = await where.store.pool.query("SELECT payload FROM events WHERE work_id = $1 AND kind = 'merge.trial' ORDER BY seq DESC LIMIT 1", [change.id]);
    const files: string[] = [...(rows[0]?.payload.files ?? [])].sort();
    assert.deepEqual(files, ['tests/direct.test.ts', 'tests/proof.test.ts', ...staticRuleTests].sort(), 'direct importer, proof and static rules only');
  } finally {
    if (priorNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = priorNodePath;
    await where.close();
  }
});
