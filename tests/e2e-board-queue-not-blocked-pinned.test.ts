import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3968: the daily catalog failed e2e:board-queue-not-blocked at its browser step on a test machine.
// A remote catalog shard runs scripts/e2e-shard.mjs over a fresh clone of the commit, and never built
// it, so the e2e serve had no dist/ and the dashboard answered 500 while /api/board still answered.
// A trial builds before its cases; the shard now runs the same build first.

const repo = fileURLToPath(new URL('..', import.meta.url));

test('unit:e2e-board-queue-not-blocked-pinned — a catalog shard builds the commit before its cases run, as a trial does, so a served dashboard exists', { timeout: 120_000 }, async () => {
  const root = await temporaryDirectory('e2e-shard-builds');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','built')"` } }),
    'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { 'needs-build': 'site' } } }),
    'site/index.html': '<h1>fixture</h1>\n',
    'e2e/cases/needs-build.json': JSON.stringify({ id: 'needs-build', title: 'The case reads the built dashboard', tags: ['api'], target: 'any', required: false,
      steps: [{ kind: 'command', name: 'the build ran', run: 'test -f dist/index.html', timeoutSeconds: 30 }] }),
  };
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
  await writeFile(join(root, 'list'), 'e2e/cases/needs-build.json\n');
  try {
    execFileSync(process.execPath, ['--import', join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs'), join(repo, 'scripts', 'e2e-shard.mjs'), 'list', 'records', '60000'], { cwd: root, stdio: 'pipe' });
  } catch { /* the records say which case failed */ }
  const records = (await readFile(join(root, 'records'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(entry => [entry.proof, entry.executed, entry.failed, entry.failingStep ?? null]), [['e2e:needs-build', 1, 0, null]],
    `the shard built the commit before its case: ${JSON.stringify(records)}`);
});
