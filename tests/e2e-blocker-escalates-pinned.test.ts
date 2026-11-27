import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3967: the daily catalog failed e2e:blocker-escalates at step 8, filling "Access token". A remote
// catalog shard runs scripts/e2e-shard.mjs over a bare checkout of the commit, which has no dist/, so the
// e2e serve had no sign-in page to show. The shard builds the checkout first, as a trial does (GY-3968),
// and only where the project declares a build: a checkout with none still runs its cases.

const repo = fileURLToPath(new URL('..', import.meta.url));

async function shard(files: Record<string, string>) {
  const root = await temporaryDirectory('e2e-shard-sign-in');
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'fixture');
  await writeFile(join(root, 'list'), 'e2e/cases/sign-in.json\n');
  try {
    execFileSync(process.execPath, ['--import', join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs'), join(repo, 'scripts', 'e2e-shard.mjs'), 'list', 'records', '60000'], { cwd: root, stdio: 'pipe' });
  } catch { /* the records say which case failed */ }
  return (await readFile(join(root, 'records'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).map(entry => [entry.proof, entry.executed, entry.failed, entry.failingStep ?? null]);
}

const fixture = (check: string, scripts?: Record<string, string>) => ({
  'package.json': JSON.stringify({ name: 'fixture', ...(scripts ? { scripts } : {}) }),
  'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { 'sign-in': 'site' } } }),
  'site/index.html': '<h1>fixture</h1>\n',
  'e2e/cases/sign-in.json': JSON.stringify({ id: 'sign-in', title: 'The served dashboard has its sign-in page', tags: ['api'], target: 'any', required: false,
    steps: [{ kind: 'command', name: 'the sign-in page is there', run: check, timeoutSeconds: 30 }] }),
});

test('unit:e2e-blocker-escalates-pinned — a catalog shard builds the dashboard before its cases, so the sign-in page exists; a checkout with no build still runs', { timeout: 120_000 }, async () => {
  const build = `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','<label>Access token</label>')"`;
  assert.deepEqual(await shard(fixture('grep -q "Access token" dist/index.html', { build })), [['e2e:sign-in', 1, 0, null]], 'the shard built the sign-in page before the case ran');
  assert.deepEqual(await shard(fixture('true')), [['e2e:sign-in', 1, 0, null]], 'a project with no build script runs its cases unbuilt');
});
