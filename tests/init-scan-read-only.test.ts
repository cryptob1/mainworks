import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';

const cli = join(import.meta.dirname, '../bin/graphyard.mjs');

test('e2e:init-scan-read-only — init --scan prints the proposal and leaves the checkout byte-identical; --scan --apply writes', async () => {
  const root = await temporaryDirectory('scan-read-only');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GRAPHYARD_') && !key.startsWith('HERDR_')));
  const run = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { cwd: root, env: { ...env, GRAPHYARD_URL: 'http://127.0.0.1:9' } }).then(result => JSON.parse(result.stdout));
  try {
    const { git } = await gitRepo({ root, files: { 'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }, null, 2), '.gitignore': 'node_modules\n' }, message: 'fixture' });
    git('remote', 'add', 'origin', 'git@github.com:owner/repo.git');
    const gitignore = await readFile(join(root, '.gitignore'));

    const scanned = await run(['init', '--scan']);
    assert.equal(scanned.proposal.repository, 'owner/repo');
    assert.equal(scanned.wroteNothing, true);
    assert.equal(git('status', '--porcelain', '--ignored'), '');
    assert.deepEqual(await readFile(join(root, '.gitignore')), gitignore);
    await assert.rejects(stat(join(root, '.graphyard')), { code: 'ENOENT' });

    const applied = await run(['init', '--scan', '--apply', '--url', 'https://graphyard.example']);
    assert.match(applied.proposal, /setup-proposal\.json$/);
    assert.ok((await stat(join(root, '.graphyard/repository-setup.json'))).isFile());
    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Mainworks coordination/);
    assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /^\.graphyard\/$/m);
  } finally { await rm(root, { recursive: true, force: true }); }
});
