import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepo } from './helpers/git-repo.js';

// GY-4114: two catalog shards ran at once over one clone and each made a `git worktree add` there. Git lists the
// clone's worktrees while it adds one, so the shard that listed while the other had made its admin directory but not
// yet written it failed "failed to read .git/worktrees/checkout/commondir". Each shard now clones the commit instead.

const repo = fileURLToPath(new URL('..', import.meta.url));

test('unit:e2e-catalog-fits-bound-pinned — a shard runs its cases while another shard is half way through making its checkout in the same clone', { timeout: 120_000 }, async () => {
  const { root } = await gitRepo({ label: 'e2e-shard-concurrent-checkout', files: {
    'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { 'own-checkout': 'site' } } }),
    'site/index.html': '<h1>fixture</h1>\n',
    'e2e/cases/own-checkout.json': JSON.stringify({ id: 'own-checkout', title: 'The shard has its checkout', tags: ['api'], target: 'any', required: false,
      steps: [{ kind: 'command', name: 'the commit is checked out', run: 'test -f site/index.html', timeoutSeconds: 30 }] }),
  } });
  writeFileSync(join(root, 'list'), 'e2e/cases/own-checkout.json\n');
  // The other shard's worktree as git leaves it between making its admin directory and writing commondir.
  mkdirSync(join(root, '.git', 'worktrees', 'checkout'), { recursive: true });
  writeFileSync(join(root, '.git', 'worktrees', 'checkout', 'commondir'), '');
  writeFileSync(join(root, '.git', 'worktrees', 'checkout', 'gitdir'), join(root, '..', 'other-shard', 'checkout', '.git\n'));
  try {
    execFileSync(process.execPath, ['--import', join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs'), join(repo, 'scripts', 'e2e-shard.mjs'), 'list', 'records', '60000'], { cwd: root, stdio: 'pipe' });
  } catch { /* the records say which case failed */ }
  const records = readFileSync(join(root, 'records'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(entry => [entry.proof, entry.executed, entry.failed, entry.failingStep ?? null]), [['e2e:own-checkout', 1, 0, null]],
    `the shard made its own checkout and ran its case: ${JSON.stringify(records)}`);
});
