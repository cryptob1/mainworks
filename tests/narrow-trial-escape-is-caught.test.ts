import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changedDeclarations, changedExports, dependencyMap, listTestFiles, repositoryRoot, selectAffected } from '../scripts/ci-tests.mjs';
import { bootstrapGate, runGate } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3750: an item's trial of a body-only change runs only the tests importing what it reaches, so
// a test reaching it through another module can escape the trial. The batch gate's selection is
// unchanged and remains the sweep: it runs that test on main, finds it failing, names the culprit
// and reverts its merge.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const item = (key: string, proofs: string[]): Work => ({ id: `work-${key}`, key, title: `${key} change`, description: `${key} change`, type: 'feature', priority: 2, criteria: [{ id: 'AC-1', text: `${key} works`, proofs }], mergeLedger: null }) as unknown as Work;

test('e2e:narrow-trial-escape-is-caught — a body-only change whose trial selection misses a failing test lands; the release check runs the sweep, finds it, names the culprit and reverts it', async () => {
  const base = await temporaryDirectory('narrow-escape');
  try {
    const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
    git(base, 'init', '-q', '--bare', '-b', 'main', origin);
    git(base, 'clone', '-q', origin, pusher);
    const write = async (files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
      git(pusher, 'add', '.');
    };
    await write({
      'package.json': '{ "type": "module" }\n',
      'graphyard.json': JSON.stringify({ gate: { core: ['smoke'] } }),
      'e2e/cases/smoke.json': '{}', 'e2e/cases/case-1.json': '{}', 'e2e/cases/case-2.json': '{}',
      'src/core.ts': 'export function inner(n: number) { return n + 1; }\n',
      'src/outer.ts': "import { inner } from './core.ts';\nexport function outer() { return inner(10); }\n",
      'tests/inner.test.ts': "import assert from 'node:assert/strict';\nimport { inner } from '../src/core.ts';\nassert.equal(inner(1), 2);\n",
      'tests/outer.test.ts': "import assert from 'node:assert/strict';\nimport { outer } from '../src/outer.ts';\nassert.equal(outer(), 11);\n",
    });
    git(pusher, 'commit', '-q', '-m', 'base');
    git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    const verified = git(pusher, 'rev-parse', 'HEAD');

    // GY-1 edits only inner's body: inner(1) still passes, outer() no longer does.
    git(pusher, 'checkout', '-q', '-b', 'item-1');
    await write({ 'src/core.ts': 'export function inner(n: number) { return n > 5 ? n + 2 : n + 1; }\n' });
    git(pusher, 'commit', '-q', '-m', 'change 1');
    const tests = listTestFiles(pusher), map = dependencyMap(pusher, tests), changed = ['src/core.ts'];
    const trial = selectAffected(changed, map, tests, changedDeclarations(changed, verified, pusher), changedExports(changed, verified, pusher));
    assert.deepEqual(trial.files, ['tests/inner.test.ts'], "the item's trial runs only the importer of inner");
    assert.match(trial.reason, /^selected 1 of 2 reachable: /);
    git(pusher, 'checkout', '-q', 'main');
    git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-1: change 1', 'item-1');
    // GY-2 lands beside it and is innocent.
    git(pusher, 'checkout', '-q', '-b', 'item-2');
    await write({ 'docs/note.md': 'note\n' });
    git(pusher, 'commit', '-q', '-m', 'change 2');
    git(pusher, 'checkout', '-q', 'main');
    git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-2: change 2', 'item-2');
    const tip = git(pusher, 'rev-parse', 'HEAD');
    git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    git(base, 'clone', '-q', origin, coordinator);

    // The release check's trial: the selection the gate makes today (no importer narrowing), each selected test really run on the commit.
    const ran: { commit: string; files: string[] }[] = [];
    let checkouts = 0;
    const reads: MergeWriterReads = {
      baseBranch: 'main', now: Date.now,
      fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
      git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
      merge: async () => { throw new Error('unused'); },
      trial: async (commit, files, trialItem, baseTip) => {
        const checkout = join(base, `checkout-${checkouts++}`);
        git(coordinator, 'worktree', 'add', '-q', '--detach', checkout, commit);
        await symlink(join(repositoryRoot, 'node_modules'), join(checkout, 'node_modules'));
        const all = listTestFiles(checkout), selection = selectAffected([...files], dependencyMap(checkout, all), all, baseTip ? changedDeclarations([...files], baseTip, checkout, commit) : undefined);
        ran.push({ commit, files: selection.files });
        const failed = selection.files.filter(file => spawnSync(process.execPath, ['--import', 'tsx', file], { cwd: checkout, stdio: 'ignore' }).status !== 0);
        const proofs = trialItem.criteria.flatMap(criterion => criterion.proofs);
        return { build: 'pass', tests: { passed: selection.files.length - failed.length, failed, files: selection.files.length }, durationMs: 1, logTail: '', files: selection.files, proofs: {},
          e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
      },
      push: async (sha, baseTip) => { git(coordinator, 'push', '-q', `--force-with-lease=main:${baseTip}`, 'origin', `${sha}:main`); return 'pushed'; },
      holds: async () => true,
      record: async () => undefined,
      createWork: async () => ({ key: 'GY-100' }),
    };
    const ports = batchGatePorts({ ...reads, git: reads.git! }, [item('GY-1', ['e2e:case-1']), item('GY-2', ['e2e:case-2'])], () => verified);
    const outcome = await runGate(ports, bootstrapGate('owner/project', verified));

    assert.ok(ran.some(entry => entry.commit === tip && entry.files.includes('tests/outer.test.ts')), 'the release check sweeps the test the trial skipped');
    assert.equal(outcome.outcome, 'reverted', JSON.stringify(outcome));
    assert.equal(outcome.outcome === 'reverted' && outcome.culprit, 'GY-1', 'it names the culprit');
    const main = git(coordinator, 'rev-parse', 'origin/main');
    assert.notEqual(main, tip);
    assert.match(git(coordinator, 'log', '-1', '--format=%s', main), /^Revert "Merge GY-1/);
    assert.equal(git(coordinator, 'show', `${main}:src/core.ts`), 'export function inner(n: number) { return n + 1; }', 'the culprit came back out');
    assert.equal(git(coordinator, 'show', `${main}:docs/note.md`), 'note', 'the innocent merge stays');
  } finally { await rm(base, { recursive: true, force: true }); }
});
