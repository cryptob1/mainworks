import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
// @ts-expect-error the scripts are plain ESM without declarations
import { deliveryFixture, scratchTrial } from '../scripts/e2e-delivery-fixture.mjs';
// @ts-expect-error the scripts are plain ESM without declarations
import { startE2eServe } from '../scripts/e2e-serve.mjs';

// GY-3196: the scheduled diagnostics run e2e:delivery-pipeline inside a trial whose network is
// unshared. The case's own scratch trial then ran the secret scan, whose binary is a download, and
// failed before its build. The case's trial must deliver with no network, as the e2e command runs it.
test('unit:e2e-delivery-pipeline-pinned — the delivery case\'s scratch trial passes with no network outside the test runner', { timeout: 180_000 }, async () => {
  const directory = await temporaryDirectory('e2e-delivery-pinned');
  const { root } = await deliveryFixture(directory);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const baseTip = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'src/store/change.mjs'), 'export const delivered = true;\n');
  git('commit', '-qam', 'Deliver');
  // The children run directly: the scan is the subject here, not the trial's container.
  const run: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, wrapper: undefined });
  const trials = join(directory, 'trials');
  await mkdir(trials);
  // The e2e command is no test-runner child, so the trial runs its scan; and it has no network.
  const saved = { context: process.env.NODE_TEST_CONTEXT, lifecycle: process.env.npm_lifecycle_event, fetch: globalThis.fetch };
  delete process.env.NODE_TEST_CONTEXT; delete process.env.npm_lifecycle_event;
  globalThis.fetch = async () => { throw new Error('no network in a diagnostics trial'); };
  try {
    const trial = await scratchTrial(trials)({ root, base: join(directory, 'managed'), mergeSha: git('rev-parse', 'HEAD'), baseTip, changedFiles: ['src/store/change.mjs'],
      proofs: ['unit:scratch-delivery'], proofFiles: [], timeoutMs: 120_000, key: 'GY-1', attribute: false, environment: { PATH: process.env.PATH! }, run, remove: async () => {} });
    assert.equal(trial.build, 'pass', trial.logTail);
    assert.deepEqual(trial.proofs['unit:scratch-delivery'], { executed: 1, failed: 0 }, trial.logTail);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.context !== undefined) process.env.NODE_TEST_CONTEXT = saved.context;
    if (saved.lifecycle !== undefined) process.env.npm_lifecycle_event = saved.lifecycle;
  }
});

// GY-4109: scripts/e2e-serve.mjs used to write .graphyard/e2e-serve-PORT.json only after
// startLocalRuntime returned. Once /healthz?ready answered 200, e2e:delivery-pipeline could run
// before that file existed and fail with ENOENT. The seed file must be on disk before the control
// plane starts serving.
test('unit:e2e-delivery-pipeline-pinned — e2e-serve writes its port seed file before the control plane starts serving', async () => {
  const cwd = await temporaryDirectory('e2e-serve-seed-before-listen');
  const port = 4391;
  const seedPath = join(cwd, '.graphyard', `e2e-serve-${port}.json`);
  const databaseUrl = 'postgres://graphyard:warm@127.0.0.1:5432/graphyard';
  type Seed = { databaseUrl?: string; delivery?: { root?: string; origin?: string; workerToken?: string; coordinatorToken?: string } };
  const observed: { seed: Seed | null } = { seed: null };
  const started = await startE2eServe({
    port, cwd, token: 'e2e-test-token',
    copyCluster: async () => {},
    startPreviews: () => ({ stop: async () => {} }),
    serve: async () => {
      observed.seed = JSON.parse(await readFile(seedPath, 'utf8')) as Seed;
      return { close: async () => {} };
    },
    startRuntime: async (_directory: string, options: { serve: (env: Record<string, string>) => Promise<{ close(): Promise<void> }> }) => {
      const served = await options.serve({ PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: databaseUrl });
      return { url: `http://127.0.0.1:${port}`, databaseUrl, cluster: { port: 5432, process: null, stop: async () => {} }, stop: () => served.close() };
    },
  });
  try {
    assert.ok(observed.seed, 'seed file must already exist when the control plane starts serving');
    assert.equal(observed.seed.databaseUrl, databaseUrl);
    assert.ok(observed.seed.delivery?.root && observed.seed.delivery?.origin && observed.seed.delivery?.workerToken && observed.seed.delivery?.coordinatorToken);
  } finally {
    await started.stop();
  }
  assert.equal(existsSync(seedPath), false, 'stopping e2e-serve removes its seed file');
});
