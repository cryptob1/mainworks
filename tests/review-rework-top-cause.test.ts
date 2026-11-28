import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completePreflight } from '../src/cli/complete.js';
import { flowNumbers } from '../src/flow-numbers.js';
import proofGuide from '../src/guide/proof.js';
import { gitRepo } from './helpers/git-repo.js';

// GY-4119: flawed or trial-incompatible proof / regression tests were the largest review rework
// cause in the 6 h after GY-4054 went live (6 of 13 review reworks: GY-4077, GY-4081, GY-4079,
// GY-4096, GY-4117, GY-4115). complete's existing bound-proof check now refuses bound proofs that
// invoke host-only binaries absent from the private merge-trial container (docker, mise) or that
// only edit an existing bound proof file in place (so the pin would pass on the base tip).

test('integration:review-rework-top-cause — complete refuses bound proofs that invoke host-only docker or mise in the trial container until stubbed or ruled trial-safe', async () => {
  const { root, git } = await gitRepo({
    label: 'review-rework-top-cause-host-bin',
    files: {
      'src/deploy.ts': 'export const deploy = () => true;\n',
      'tests/existing.test.ts': "import { test } from 'node:test';\ntest('existing', () => {});\n",
    },
  });
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'graphyard/gy-1-1');

  // Reproduces GY-4117 (localTransport() invoking real docker) and GY-4115 (execFileSync('mise', ...)).
  const dockerProof = 'tests/compose-deploy-pipe.test.ts';
  const miseProof = 'tests/sandbox-mise.test.ts';
  await writeFile(join(root, 'src/deploy.ts'), 'export const deploy = () => "retried";\n');
  await writeFile(
    join(root, dockerProof),
    [
      "import { test } from 'node:test';",
      "test('integration:compose-pipe', () => {",
      '  const transport = ' + 'local' + 'Transport();',
      '  return transport;',
      '});',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, miseProof),
    [
      "import { test } from 'node:test';",
      "import { execFileSync } from 'node:child_process';",
      "test('integration:sandbox-mise', () => {",
      '  ' + 'execFileSync(' + "'mi" + "se', ['which', 'node']);",
      '});',
      '',
    ].join('\n'),
  );
  git('add', 'src/deploy.ts', dockerProof, miseProof);
  git('commit', '-qm', 'GY-1: add proofs\n\nAC-1 — met: added deploy retry and mise bind');

  const work = {
    key: 'GY-1',
    type: 'bug',
    criteria: [{ id: 'AC-1', text: 'Works in trial container', proofs: ['integration:compose-pipe', 'integration:sandbox-mise'] }],
  };

  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.match(error.message, /compose-deploy-pipe\.test\.ts:3/);
    assert.match(error.message, /sandbox-mise\.test\.ts:4/);
    assert.match(error.message, /trial container/i);
    assert.match(error.message, /trial-safe/);
    return true;
  });

  // Stubbing the docker proof leaves only the mise proof flagged.
  await writeFile(
    join(root, dockerProof),
    "import { test } from 'node:test';\ntest('integration:compose-pipe', () => ({ stub: true }));\n",
  );
  git('commit', '-qam', 'GY-1: inject stub transport for compose proof');
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.doesNotMatch(error.message, /compose-deploy-pipe\.test\.ts/);
    assert.match(error.message, /sandbox-mise\.test\.ts:4/);
    return true;
  });

  // Ruling the remaining proof trial-safe satisfies complete.
  git('commit', '-q', '--allow-empty', '-m', `GY-1: trial-safe ruling\n\n${miseProof} — trial-safe: uses a fake mise executable on PATH`);
  await completePreflight(root, work, git('rev-parse', 'HEAD'));
});

test('integration:review-rework-top-cause — complete refuses a head that only edits an existing bound proof file in place', async () => {
  const { root, git } = await gitRepo({
    label: 'review-rework-top-cause-pin',
    files: {
      'tests/reviews-launch-side-by-side.test.ts': "import { test } from 'node:test';\ntest('side by side', () => {});\n",
    },
  });
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'graphyard/gy-2-1');

  // Reproduces GY-4079: fixes the flake and puts the bound pin inside the same existing test file.
  await writeFile(
    join(root, 'tests/reviews-launch-side-by-side.test.ts'),
    "import { test } from 'node:test';\ntest('side by side', () => {});\ntest('unit:reviews-launch-side-by-side-pinned', () => {});\n",
  );
  git('commit', '-qam', 'GY-2: fix flake and pin in same file\n\nAC-1 — met: flake fixed and pinned');

  const work = {
    key: 'GY-2',
    type: 'bug',
    criteria: [{ id: 'AC-1', text: 'Flake pinned', proofs: ['unit:reviews-launch-side-by-side-pinned'] }],
  };

  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.match(error.message, /tests\/reviews-launch-side-by-side\.test\.ts/);
    assert.match(error.message, /-pinned\.test\.ts/);
    return true;
  });

  // Moving the bound pin into its own new *-pinned.test.ts file satisfies complete.
  await writeFile(
    join(root, 'tests/reviews-launch-side-by-side.test.ts'),
    "import { test } from 'node:test';\ntest('side by side', () => { /* deterministic gate */ });\n",
  );
  await writeFile(
    join(root, 'tests/reviews-launch-side-by-side-pinned.test.ts'),
    "import { test } from 'node:test';\ntest('unit:reviews-launch-side-by-side-pinned', () => {});\n",
  );
  git('add', 'tests/reviews-launch-side-by-side.test.ts', 'tests/reviews-launch-side-by-side-pinned.test.ts');
  git('commit', '-qm', 'GY-2: move pin to separate *-pinned.test.ts file');
  await completePreflight(root, work, git('rev-parse', 'HEAD'));
});

test('integration:review-rework-top-cause — Builder proof guide names trial-container stubs and separate pinned files, and flowNumbers tracks flawed proof tests', () => {
  assert.match(proofGuide, /private merge-trial container/i);
  assert.match(proofGuide, /docker.*mise|mise.*docker/i);
  assert.match(proofGuide, /-pinned\.test\.ts/);

  const now = Date.parse('2026-11-28T09:16:00Z');
  const findings = [
    ['GY-4117', 'tests/compose-deploy-survives-image-export-pipe-error.test.ts:68 — Bound E2E proof unconditionally invokes real `docker` via `localTransport()`, which fails with ENOENT inside the private-root merge-trial container'],
    ['GY-4115', 'tests/sandbox-mise-data-dir.test.ts:51 — `integration:sandbox-mise-resolves-host-tools` executes `mise which node`, but `mise` is not installed in the private trial container image'],
    ['GY-4079', 'tests/reviews-launch-side-by-side.test.ts:63 — AC-1 unmet: the pin passes on the base tip. Move the pin to a new <name>-pinned.test.ts file (GY-3997).'],
    ['GY-4077', "tests/warm-commit-takes-image-lock.test.ts:62 — `file = join(root, 'deploy.json')` makes `deployPass` compute `controlPlaneRecordPath` outside each install's temporary directory"],
  ];
  const items = findings.map(([key, finding], index) => ({
    key, title: key, stage: 'build', stageEnteredAt: new Date(now).toISOString(), mergedAt: null, attempts: [],
    events: [{ kind: 'rework', at: new Date(now - (index + 1) * 60_000).toISOString(), binding: `abc${index}:verdict:review-codex`, reason: `${key}: review-codex requested changes on abc: BLOCKING: ${finding}. The verdict stands.` }],
  }));
  assert.deepEqual(flowNumbers(items, 24, now).reviewReasons, [{ label: 'flawed proof test', count: 4 }]);
});
