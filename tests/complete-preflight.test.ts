import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { completeCommand } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';
import { featureCaseFailure, requiredProofFailure, trialFailureReason } from '../src/merge-writer/executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3638: complete refuses in seconds what the merge writer would refuse after review, the queue
// and trial start-up — a missing proof id, a missing feature E2E case, a merge conflict against
// the fetched base, or a failing fast gate — reusing the executor's own functions and sentences.

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A fixture git repository with an `origin/main` base commit and a work branch commit on top. */
async function fixtureRepo(label: string, baseFiles: Record<string, string>, headFiles: Record<string, string>, mainAdvance?: Record<string, string>) {
  const root = await temporaryDirectory(label);
  git(root, 'init', '--quiet', '-b', 'main');
  await writeFiles(root, { '.gitignore': '.graphyard/\n', ...baseFiles });
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'base');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', baseSha);

  git(root, 'checkout', '--quiet', '-b', 'graphyard/gy-1-1');
  await writeFiles(root, headFiles);
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'worker change');
  const head = git(root, 'rev-parse', 'HEAD');

  if (mainAdvance) {
    git(root, 'checkout', '--quiet', 'main');
    await writeFiles(root, mainAdvance);
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'main moved');
    git(root, 'update-ref', 'refs/remotes/origin/main', git(root, 'rev-parse', 'HEAD'));
    git(root, 'checkout', '--quiet', 'graphyard/gy-1-1');
  }

  return { root, head };
}

function stubContext(root: string, head: string) {
  const calls: { path: string; body: unknown }[] = [];
  const context = {
    args: ['1', '--head', head],
    repositoryRoot: () => root,
    print: () => {},
    api: async (path: string, body: unknown) => { if (path !== 'owner') calls.push({ path, body }); return { submitted: true }; },
  } as unknown as CliContext;
  return { context, calls };
}

test('unit:complete-preflight-refuses-what-the-trial-would — refuses missing proof id, missing feature E2E case, merge conflict, and failing fast gate; accepts clean head; non-fast-gate checks finish under 2s', async () => {
  // 1. Missing unit/integration proof id in tests/*.test.ts on the head.
  {
    const { root, head } = await fixtureRepo('preflight-missing-proof', { 'src/a.ts': 'export const a = 1;\n' }, {
      'tests/a.test.ts': "import { test } from 'node:test';\ntest('unlabeled case', () => {});\n",
    });
    const work = {
      id: 'id-1', key: 'GY-1', type: 'bug',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:missing-proof-id'] }],
    };
    const { context, calls } = stubContext(root, head);
    const started = performance.now();
    await assert.rejects(
      completeCommand.run(context, work as never),
      (error: Error) => {
        assert.equal(error.message, requiredProofFailure(work as never, { proofs: {} }));
        return true;
      },
    );
    assert.ok(performance.now() - started < 2000, 'missing-proof check finishes under 2s');
    assert.equal(calls.length, 0, 'no submission recorded on missing proof id');
  }

  // 2. featureCaseFailure refuses a feature head that did not add or modify its bound E2E case.
  {
    const { root, head } = await fixtureRepo('preflight-missing-e2e', { 'src/a.ts': 'export const a = 1;\n' }, {
      'tests/a.test.ts': "import { test } from 'node:test';\ntest('unit:feature-proof — works', () => {});\n",
    });
    const work = {
      id: 'id-2', key: 'GY-2', type: 'feature',
      criteria: [
        { id: 'AC-1', text: 'Unit', proofs: ['unit:feature-proof'] },
        { id: 'AC-2', text: 'E2E', proofs: ['e2e:feature-case'] },
      ],
    };
    const { context, calls } = stubContext(root, head);
    const started = performance.now();
    await assert.rejects(
      completeCommand.run(context, work as never),
      (error: Error) => {
        assert.equal(error.message, featureCaseFailure(work as never, []));
        return true;
      },
    );
    assert.ok(performance.now() - started < 2000, 'feature-case check finishes under 2s');
    assert.equal(calls.length, 0, 'no submission recorded on missing feature E2E case');
  }

  // 3. Merge conflict against fetched origin/main refuses, naming the files and saying to run sync.
  {
    const { root, head } = await fixtureRepo(
      'preflight-conflict',
      { 'src/shared.ts': 'export const v = 0;\n' },
      { 'src/shared.ts': 'export const v = 1;\n', 'tests/a.test.ts': "import { test } from 'node:test';\ntest('unit:conflict-proof — works', () => {});\n" },
      { 'src/shared.ts': 'export const v = 2;\n' },
    );
    const work = {
      id: 'id-3', key: 'GY-3', type: 'bug',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:conflict-proof'] }],
    };
    const { context, calls } = stubContext(root, head);
    const started = performance.now();
    await assert.rejects(
      completeCommand.run(context, work as never),
      (error: Error) => {
        const expectedPrefix = trialFailureReason({ conflict: ['src/shared.ts'] })!;
        assert.ok(error.message.includes(expectedPrefix), `expected "${expectedPrefix}" in "${error.message}"`);
        assert.match(error.message, /\bsync\b/i, 'conflict refusal tells the worker to run sync');
        return true;
      },
    );
    assert.ok(performance.now() - started < 2000, 'merge-tree conflict check finishes under 2s');
    assert.equal(calls.length, 0, 'no submission recorded on merge conflict');
  }

  // 4. Failing fast gate refuses when the repository carries the fast gate files, naming the failing test.
  {
    const { root, head } = await fixtureRepo('preflight-fast-gate-fail', { 'package.json': '{"type":"module"}\n' }, {
      'tests/no-wall-clock-time-bombs.test.ts': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('wall clock bomb detected', () => { assert.fail('boom'); });\n",
      'tests/ci-shards.test.ts': "import { test } from 'node:test';\ntest('shards ok', () => {});\n",
      'tests/a.test.ts': "import { test } from 'node:test';\ntest('unit:fast-gate-proof — works', () => {});\n",
    });
    const work = {
      id: 'id-4', key: 'GY-4', type: 'bug',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:fast-gate-proof'] }],
    };
    const { context, calls } = stubContext(root, head);
    await assert.rejects(
      completeCommand.run(context, work as never),
      (error: Error) => {
        assert.ok(error.message.startsWith('trial failed: tests '), `uses trialFailureReason sentence: ${error.message}`);
        assert.ok(error.message.includes('wall clock bomb detected'), `names the failing test: ${error.message}`);
        return true;
      },
    );
    assert.equal(calls.length, 0, 'no submission recorded on failing fast gate');
  }

  // 5. Clean head (without fast gates: under 2s; and with passing fast gates) is accepted and submitted.
  {
    const { root, head } = await fixtureRepo('preflight-clean', { 'src/a.ts': 'export const a = 1;\n' }, {
      'tests/a.test.ts': "import { test } from 'node:test';\ntest('unit:clean-proof — works', () => {});\n",
      'e2e/cases/clean-case.json': '{"id":"clean-case"}\n',
    });
    const work = {
      id: 'id-5', key: 'GY-5', type: 'feature',
      criteria: [
        { id: 'AC-1', text: 'Unit', proofs: ['unit:clean-proof'] },
        { id: 'AC-2', text: 'E2E', proofs: ['e2e:clean-case'] },
      ],
    };
    const { context, calls } = stubContext(root, head);
    const started = performance.now();
    await completeCommand.run(context, work as never);
    assert.ok(performance.now() - started < 2000, 'clean head non-fast-gate checks finish under 2s');
    assert.deepEqual(calls, [{ path: 'work/id-5/submit', body: { epoch: 1, head } }]);
  }
});
