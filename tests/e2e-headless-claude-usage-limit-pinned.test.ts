import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { volatileFilesystem } from '../src/install/worktree-root.js';
import { gitRepo } from './helpers/git-repo.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4105: the daily catalog failed e2e:headless-claude-usage-limit on a test machine. A remote
// shard container mounts /tmp (and HOME=/tmp) as tmpfs while <run>/repo sits on durable disk, and
// scripts/e2e-shard.mjs created its shard worktree under tmpdir(). Inside that tmpfs worktree,
// headlessWorkers' setupMaster failed verifyWorktreeRoot on tmpfs in all four before hooks, and the
// unclosed servers hung the file until the 300 s bound killed it. Putting the shard's worktree
// beside the durable checkout when tmpdir() is volatile fixes the cause.

const repo = fileURLToPath(new URL('..', import.meta.url));

test('unit:e2e-headless-claude-usage-limit-pinned — a catalog shard whose tmpdir is tmpfs puts its worktree on durable storage beside the checkout', { timeout: 120_000 }, async () => {
  assert.equal(volatileFilesystem('/dev/shm'), 'tmpfs', '/dev/shm must be a tmpfs to exercise the remote shard container layout');
  const run = await temporaryDirectory('e2e-shard-tmpfs-run');
  const checkout = join(run, 'repo');
  const check = `node -e "const fs = require('node:fs'); const type = Number(fs.statfsSync(process.cwd()).type); if (type === 0x01021994 || type === 0x858458f6) { console.error('worktree is on volatile fs: ' + process.cwd()); process.exit(1); }"`;
  await gitRepo({ root: checkout, message: 'fixture', files: {
    'package.json': JSON.stringify({ name: 'fixture' }),
    'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { 'durable-worktree': 'site' } } }),
    'site/index.html': '<h1>fixture</h1>\n',
    'e2e/cases/durable-worktree.json': JSON.stringify({ id: 'durable-worktree', title: 'Shard worktree sits on durable storage', tags: ['workers'], target: 'any', required: false,
      steps: [{ kind: 'command', name: 'worktree is not on tmpfs', run: check, timeoutSeconds: 30 }] }),
  } });
  await writeFile(join(checkout, 'list'), 'e2e/cases/durable-worktree.json\n');
  try {
    execFileSync(process.execPath, ['--import', join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs'), join(repo, 'scripts', 'e2e-shard.mjs'), 'list', 'records', '60000'], {
      cwd: checkout, stdio: 'pipe', env: { ...process.env, TMPDIR: '/dev/shm', HOME: '/dev/shm' },
    });
  } catch { /* the records say which case failed */ }
  const records = (await readFile(join(checkout, 'records'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(entry => [entry.proof, entry.executed, entry.failed, entry.failingStep ?? null]), [['e2e:durable-worktree', 1, 0, null]],
    `the shard worktree must sit on durable disk when TMPDIR and HOME are tmpfs: ${JSON.stringify(records)}`);
});
