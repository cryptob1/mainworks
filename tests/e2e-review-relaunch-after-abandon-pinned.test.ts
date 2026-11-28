import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitRepo } from './helpers/git-repo.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4092: e2e:review-relaunch-after-abandon timed out at 300 s in the scheduled full run.
// Two things combined to produce a silent 300 s hang:
// 1. scripts/e2e-shard.mjs created each catalog shard's worktree under tmpdir() (/tmp, a tmpfs in
//    remote shard containers), so reviewAbandonHarness's setupMaster refused its worktreeRoot on
//    tmpfs.
// 2. reviewAbandonHarness started its HTTP server and Postgres store before setupMaster without
//    closing them on failure, so before() threw leaving harness undefined and the open HTTP server
//    kept node --test alive until the 300 s step timeout killed it with no buffered output.

const repo = fileURLToPath(new URL('..', import.meta.url));
const tsxLoader = join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs');

test('unit:e2e-review-relaunch-after-abandon-pinned — e2e-shard places its worktree on durable storage beside the checkout when tmpdir is a tmpfs', { timeout: 120_000 }, async () => {
  const scratch = await temporaryDirectory('e2e-shard-durable-worktree');
  const fakeTmp = join(scratch, 'fake-tmpfs');
  const checkoutParent = join(scratch, 'durable-run');
  await mkdir(fakeTmp, { recursive: true });
  await mkdir(checkoutParent, { recursive: true });

  const { root } = await gitRepo({
    root: join(checkoutParent, 'repo'),
    message: 'fixture',
    files: {
      'package.json': JSON.stringify({ name: 'fixture' }),
      'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { 'cwd-check': 'site' } } }),
      'site/index.html': '<h1>fixture</h1>\n',
      'e2e/cases/cwd-check.json': JSON.stringify({
        id: 'cwd-check', title: 'The shard worktree sits on durable storage', tags: ['api'], target: 'any', required: false,
        steps: [{ kind: 'command', name: 'print cwd', run: `pwd > '${join(scratch, 'case-cwd.txt')}'`, timeoutSeconds: 30 }],
      }),
    },
  });
  await writeFile(join(root, 'list'), 'e2e/cases/cwd-check.json\n');

  // Make statfsSync report TMPFS_MAGIC (0x01021994) for fakeTmp and ext4 (0xef53) elsewhere.
  const preload = join(scratch, 'tmpfs-preload.mjs');
  await writeFile(preload, `
import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const fakeTmp = ${JSON.stringify(resolve(fakeTmp))};
const origStatfsSync = fs.statfsSync;
fs.statfsSync = (path, ...rest) => {
  const info = origStatfsSync(path, ...rest);
  const p = resolve(String(path));
  if (p === fakeTmp || p.startsWith(fakeTmp + '/')) return { ...info, type: 0x01021994 };
  return { ...info, type: 0xef53 };
};
syncBuiltinESMExports();
`);

  try {
    execFileSync(process.execPath, ['--import', tsxLoader, join(repo, 'scripts', 'e2e-shard.mjs'), 'list', 'records', '60000'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, TMPDIR: fakeTmp, TMP: fakeTmp, TEMP: fakeTmp, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() },
    });
  } catch (error: any) {
    assert.fail(`e2e-shard exited ${error.status}: stdout=${error.stdout?.toString?.() ?? ''} stderr=${error.stderr?.toString?.() ?? ''} records=${await readFile(join(root, 'records'), 'utf8').catch(() => '')}`);
  }

  const caseCwd = (await readFile(join(scratch, 'case-cwd.txt'), 'utf8')).trim();
  assert.equal(caseCwd.startsWith(resolve(fakeTmp)), false, `shard worktree was placed on tmpfs (${caseCwd})`);
  assert.ok(caseCwd.startsWith(`${resolve(checkoutParent)}/`), `shard worktree should sit beside the checkout under ${checkoutParent}, got ${caseCwd}`);
});

test('unit:e2e-review-relaunch-after-abandon-pinned — reviewAbandonHarness closes its server and store on setup failure so node --test exits instead of hanging', { timeout: 60_000 }, async () => {
  const scratch = await temporaryDirectory('review-abandon-cleanup');
  const preload = join(scratch, 'fail-tmpfs-preload.mjs');
  await writeFile(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const origStatfs = fs.promises.statfs;
fs.promises.statfs = async (path, ...rest) => {
  const info = await origStatfs(path, ...rest);
  return { ...info, type: 0x01021994 };
};
syncBuiltinESMExports();
`);

  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--import', tsxLoader, '--test', 'tests/review-relaunch-after-abandon.test.ts'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = await new Promise<{ exited: boolean; code: number | null }>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ exited: false, code: null }); }, 20_000);
    child.once('exit', code => { clearTimeout(timer); resolve({ exited: true, code }); });
  });
  assert.equal(exited.exited, true, `review-relaunch-after-abandon.test.ts hung after setupMaster failed instead of exiting:\n${output}`);
  assert.notEqual(exited.code, 0, 'the failed setup must exit nonzero');
  assert.match(output, /tmpfs/, `expected the tmpfs refusal in output:\n${output}`);
});
