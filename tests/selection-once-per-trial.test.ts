import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runMergeTrial } from '../src/merge-writer/executor.js';
import { readTestSelections, testSelectionSummary } from '../src/merge-writer/test-selection.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { gitRepo } from './helpers/git-repo.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3787: a trial picks its tests once, and that step costs little more than the selector itself.

const proof = 'integration:selection-once-per-trial';
const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const policy = { mode: 'local', candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null }, mergeGate: { perCandidate: [], preMerge: [
  { check: 'test', command: 'node runner.cjs', source: 'script', reason: 'fixture', selection: { command: 'node select.cjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] } };
const selectable = 300;

/** A seeded repository: 300 selectable tests of 600, each importing the same 60 modules of 270 KB; tests/t0 holds the proof, and tests/t1 fails its first run on the head. */
async function fixture() {
  const state = await temporaryDirectory('selection-once-state', tmpdir()), base = await temporaryDirectory('selection-once-trials', tmpdir());
  const { root, git } = await gitRepo({ root: await temporaryDirectory('selection-once-repo', tmpdir()) });
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  write('package.json', JSON.stringify({ name: 'fixture', scripts: {} }));
  write('package-lock.json', JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }));
  write('graphyard.json', JSON.stringify({ delivery: policy }));
  // The selector counts its runs.
  write('select.cjs', `require('node:fs').appendFileSync(${JSON.stringify(join(state, 'selected'))}, 'x');
console.log('affected: selected ${selectable} of 400 reachable: fixture');
for (let n = 0; n < ${selectable}; n++) console.log('tests/t' + n + '.test.ts');
`);
  // The runner takes run-tests.ts's options, runs nothing but what the case decides and reports TAP.
  write('runner.cjs', `const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const after = name => process.argv[process.argv.indexOf(name) + 1];
const files = readFileSync(after('--files-from'), 'utf8').split('\\n').filter(Boolean), fixed = existsSync('src/fixed');
const once = ${JSON.stringify(join(state, 'flaked'))};
let status = 0;
for (const file of files) {
  let ok = file !== 'tests/t0.test.ts' || fixed;
  if (file === 'tests/t1.test.ts' && fixed && !existsSync(once)) { writeFileSync(once, ''); ok = false; }
  const name = file === 'tests/t0.test.ts' ? '${proof} holds' : 'case ' + file;
  console.log('# Subtest: ' + file + '\\n    ' + (ok ? 'ok' : 'not ok') + ' 1 - ' + name + '\\n' + (ok ? 'ok' : 'not ok') + ' 1 - ' + file);
  appendFileSync(after('--durations'), JSON.stringify({ file, durationMs: 1, passed: ok }) + '\\n');
  if (!ok) status = 1;
}
process.exit(status);
`);
  const line = 'export const value = { text: "a string", other: "another string" };\n';
  for (let n = 0; n < 60; n++) write(`src/m${n}.ts`, `${n < 59 ? `import './m${n + 1}.js';\n` : ''}${line.repeat(4000)}`);
  for (let n = 0; n < 600; n++) write(`tests/t${n}.test.ts`, `import '../src/m0.js';\n// ${n === 0 ? proof : n}\n`);
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const tip = git('rev-parse', 'HEAD');
  write('src/fixed', '');
  git('add', '-A'); git('commit', '-q', '-m', 'the change');
  const merge = git('rev-parse', 'HEAD');
  const children: { command: string; ms: number; wrapper: readonly string[] }[] = [];
  // The fixture's own commands run for real, outside the trial container (covered separately).
  const run: ChildRun = async (command, args, options) => {
    const at = Date.now();
    try { return await defaultChildRun(command, args, { ...options, wrapper: undefined, ...(command === 'git' ? { env: { ...process.env, ...identity, ...options?.env } } : {}) }); }
    finally { children.push({ command: [command, ...args].join(' '), ms: Date.now() - at, wrapper: options?.wrapper ?? [] }); }
  };
  const timings: { step: string; ms: number }[] = [];
  const common = { root, base, key: 'GY-1', mergeSha: merge, baseTip: tip, changedFiles: ['src/fixed'], caches: true, timeoutMs: 240_000, run, secretScan: false as const, remote: { hosts: [] },
    onTiming: (step: string, ms: number) => { timings.push({ step, ms }); } };
  return { root, common, timings, children, selected: () => existsSync(join(state, 'selected')) ? readFileSync(join(state, 'selected'), 'utf8').length : 0 };
}

test(`${proof} — a trial whose flaky test reruns and whose proof runs on the base tip selects once, within 3 s of the selector, holding no container slot`, { timeout: 300_000 }, async () => {
  const { root, common, timings, children, selected } = await fixture();
  const trial = await runMergeTrial({ ...common, proofs: [proof], proofFiles: ['tests/t0.test.ts'], reproduce: true });
  assert.deepEqual(trial.tests.failed, [], trial.logTail);
  assert.deepEqual(trial.flaked?.files, ['tests/t1.test.ts'], 'the flaky file reran on the merge commit');
  assert.deepEqual(trial.passingOnBase, [], 'the proof ran on the base tip and failed there');

  const steps = timings.filter(timing => timing.step === 'selection'), selector = children.filter(child => child.command.includes('select.cjs') && child.command.startsWith('node'));
  assert.ok(steps[0]!.ms - selector[0]!.ms <= 3000, `the selection step took ${steps[0]!.ms}ms around a ${selector[0]!.ms}ms selector`);
  assert.equal(selected(), 1, 'the selector ran once');
  assert.equal(steps.length, 1, 'the record shows one selection timing');
  // The launcher waits for a container slot only under a load; a nested trial has no launcher.
  if (!existsSync('/etc/graphyard-trial')) assert.equal(JSON.parse(selector[0]!.wrapper.at(-1)!).load, undefined, 'the selector starts without waiting for a container slot');

  // The status line: the share of every test file beside the share of the reachable ones.
  assert.deepEqual(testSelectionSummary(readTestSelections(root)), { trials: 1, medianShareSelected: '75%', medianShareOfAllSelected: '50%', medianShareOfAll: { before: '50%', after: null } });
  assert.deepEqual(testSelectionSummary([{ at: 'x', selected: 1, reachable: 2 }]), { trials: 1, medianShareSelected: '50%', medianShareOfAllSelected: null, medianShareOfAll: { before: null, after: null } }, 'a trial recorded before this counted only the reachable files');
});

test(`${proof} — a retried trial reuses the first attempt's selection`, { timeout: 300_000 }, async () => {
  const { common, timings, selected } = await fixture();
  let killed = false;
  const run: ChildRun = (command, args, options) => {
    if (args.includes('runner.cjs') && !killed) { killed = true; throw Object.assign(new Error('killed'), { signal: 'SIGKILL', status: null, stdout: '', stderr: '' }); }
    return common.run(command, args, options);
  };
  const trial = await runTrial({ ...common, run, groupSize: 1000 });
  assert.equal(trial.retried?.length, 1);
  assert.equal(selected(), 1);
  assert.equal(timings.filter(timing => timing.step === 'selection').length, 1);
});

test('e2e:selection-once-per-trial — a trial of a one-file change on a test install records one selection step under 10 s', { timeout: 300_000 }, async () => {
  const { common, timings } = await fixture();
  const trial = await runMergeTrial({ ...common, proofs: [proof], proofFiles: ['tests/t0.test.ts'], reproduce: true });
  assert.deepEqual(trial.tests.failed, [], trial.logTail);
  const steps = timings.filter(timing => timing.step === 'selection');
  assert.equal(steps.length, 1);
  assert.ok(steps[0]!.ms < 10_000, `the selection step took ${steps[0]!.ms}ms`);
});
