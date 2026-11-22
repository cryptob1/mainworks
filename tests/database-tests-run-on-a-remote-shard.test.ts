import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { liveServersUnder } from '../src/postgres-stop.js';
import { remoteableTestFile, type HostReading } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-3612 AC-1: a real test file that calls withDatabase runs and passes on a remote shard:
// the shard starts the shared pre-migrated Postgres cluster in its container, sets
// GRAPHYARD_TEST_DATABASE_URL, and stops and removes the cluster when the shard ends.

const source = fileURLToPath(new URL('..', import.meta.url));
const dbFile = 'tests/work-replay.test.ts';

const nonTemplatePostgresDirs = async (root: string) =>
  (await readdir(root).catch(() => [] as string[])).filter(name => name.startsWith('graphyard-postgres-') && !name.startsWith('graphyard-postgres-template-') && !name.endsWith('.owner'));

test('integration:database-tests-run-on-a-remote-shard — a real withDatabase test file passes on the remote host and leaves no Postgres process or data directory behind', { timeout: 300_000 }, async () => {
  const dbSource = readFileSync(join(source, dbFile), 'utf8');
  assert.equal(remoteableTestFile(dbSource), true, `${dbFile} is remoteable`);

  const image = 'graphyard-trial:db-remote-shard';
  const hosts = await shardHosts('db-remote-shard', ['box'], { [image]: `sha256:${'db12'.repeat(16)}` });
  const shardTmp = await temporaryDirectory('db-remote-shard-tmp');
  const repository = await shardRepository('db-remote-shard-repo', [], {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { build: 'true' } }),
    'graphyard.json': JSON.stringify({
      delivery: {
        mergeGate: {
          perCandidate: [],
          preMerge: [{
            check: 'test',
            command: `env TMPDIR=${shardTmp} node --import tsx ${join(source, 'tests/helpers/run-tests.ts')}`,
            source: 'script',
            reason: 'fixture',
            selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' },
          }],
        },
      },
    }),
    [dbFile]: dbSource,
  });
  // Drop package-lock.json so the stand-in warm image uses `-none` and keeps the repo's linked node_modules.
  await rm(join(repository.root, 'package-lock.json'), { force: true });
  for (const path of ['src', 'scripts/ci-tests.mjs', 'tests/helpers', 'node_modules']) {
    symlinkSync(join(source, path), join(repository.root, path));
  }
  git(repository.root, 'add', '-A');
  git(repository.root, 'commit', '-qm', 'link sources for real database test');
  const sha = git(repository.root, 'rev-parse', 'HEAD');

  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node' && args[0] === 'scripts/select.mjs') return dbFile;
    if (command === 'env' && args.includes('tests/helpers/run-tests.ts')) return defaultChildRun(command, args, { ...options, wrapper: undefined });
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const reading = (name: string, cores: number, busy: number): HostReading => ({ name, cores, busy, steal: 0, celsius: 60, limit: 92, away: false });
  const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
  const timings: string[] = [];
  try {
    const result = await runTrial({
      root: repository.root,
      base: await temporaryDirectory('db-remote-shard-base'),
      mergeSha: sha,
      changedFiles: [dbFile],
      timeoutMs: 240_000,
      cores: 2,
      run,
      retries: 0,
      onTiming: step => timings.push(step),
      remote: { hosts: ['gy-compute@box'], read: async () => [reading('this-machine', 2, 2), reading('gy-compute@box', 8, 0)] },
    });
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed }, { passed: 1, failed: [] }, result.logTail);
    assert.ok(timings.some(step => /^tests: shard \d+ on gy-compute@box$/.test(step)), `expected shard on remote host, got: ${timings.join(', ')}`);
    assert.match(result.logTail, /\[gy-compute@box\]/, result.logTail);
    assert.match(result.logTail, /replay reads the baseline/, result.logTail);
  } finally {
    if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE;
    else process.env.GRAPHYARD_TRIAL_IMAGE = previous;
  }

  assert.deepEqual(liveServersUnder(shardTmp), [], 'no Postgres process left behind');
  assert.deepEqual(await nonTemplatePostgresDirs(shardTmp), [], 'no Postgres data directory left behind');
  assert.ok((await readdir(shardTmp)).some(name => name.startsWith('graphyard-postgres-template-')), 'the remote shard built/used the shared pre-migrated Postgres template');
});
