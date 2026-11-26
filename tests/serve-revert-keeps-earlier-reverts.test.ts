import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runServeRevert, type ServeRevertPorts } from '../src/merge-writer/serve-revert.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git } from './helpers/git-repo.js';

// GY-3881 AC-2: reverting the newest landing takes back out only that landing. A plain revert
// nothing owns, or a direct landing, that sits before the merge on main stays on main: the merge's
// "before" is its own first parent, never the previous owned landing.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const passTrial = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {} } as unknown as MergeTrialRun;

const item = (key: string, mergeSha: string) => ({
  id: `work-${key}`, key, title: `${key} page`, description: '', type: 'feature', priority: 2,
  criteria: [{ id: 'AC-1', text: 'works', proofs: [`e2e:case-${key}`] }], mergeLedger: { mergeSha },
}) as unknown as Work;

async function repository(label: string) {
  const base = await temporaryDirectory(label);
  const repo = join(base, 'repo');
  git(base, 'init', '-q', '-b', 'main', repo);
  const write = async (files: Record<string, string>, message: string) => {
    for (const [name, text] of Object.entries(files)) { await mkdir(join(repo, name, '..'), { recursive: true }); await writeFile(join(repo, name), text); }
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const land = async (key: string, files: Record<string, string>) => {
    git(repo, 'checkout', '-q', '-b', key);
    await write(files, key);
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${key}: page`, key);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const verified = await write({ 'keep.txt': 'keep\n' }, 'base');
  const ports: ServeRevertPorts = {
    git: async (args, extra) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extra } }),
    trial: async () => passTrial,
    push: async (revertSha, baseTip) => { if (git(repo, 'rev-parse', 'main') !== baseTip) return 'rejected'; git(repo, 'update-ref', 'refs/heads/main', revertSha); return 'pushed'; },
    file: async () => ({ key: 'GY-9' }),
  };
  const revert = (work: Work[], key: string) => {
    const served = git(repo, 'rev-parse', 'main');
    return runServeRevert(ports, { serve: served, failingCase: `case-${key}`, failingStep: null, failingReason: null, lastVerified: verified, baseTip: served, baseBranch: 'main', work });
  };
  const tree = (rev: string) => git(repo, 'rev-parse', `${rev}^{tree}`);
  const has = (rev: string, path: string) => { try { git(repo, 'cat-file', '-e', `${rev}:${path}`); return true; } catch { return false; } };
  return { base, repo, write, land, revert, tree, has };
}

test('integration:serve-revert-keeps-earlier-reverts — reverting GY-3 after a plain revert of GY-2 removes only GY-3: main equals the tree after the plain revert', async t => {
  const r = await repository('serve-revert-keeps-reverts');
  t.after(() => rm(r.base, { recursive: true, force: true }));
  const one = await r.land('GY-1', { 'one.txt': '1\n' });
  const two = await r.land('GY-2', { 'two.txt': '2\n' });
  git(r.repo, 'revert', '--no-edit', '-m', '1', two);
  const plainRevert = git(r.repo, 'rev-parse', 'HEAD');
  const three = await r.land('GY-3', { 'three.txt': '3\n' });
  const result = await r.revert([item('GY-1', one), item('GY-2', two), item('GY-3', three)], 'GY-3');
  assert.equal(result.outcome, 'reverted');
  const tip = git(r.repo, 'rev-parse', 'main');
  assert.equal(r.tree(tip), r.tree(plainRevert));
  assert.equal(r.has(tip, 'two.txt'), false, "GY-2's change stays reverted");
  assert.equal(r.has(tip, 'three.txt'), false);
  assert.equal(r.has(tip, 'one.txt'), true);
});

test('integration:serve-revert-keeps-earlier-reverts — a direct landing ahead of a merge stays when the merge is reverted', async t => {
  const r = await repository('serve-revert-keeps-direct');
  t.after(() => rm(r.base, { recursive: true, force: true }));
  const one = await r.land('GY-1', { 'one.txt': '1\n' });
  const direct = await r.write({ 'direct.txt': 'direct\n' }, 'a direct landing');
  const three = await r.land('GY-3', { 'three.txt': '3\n' });
  const result = await r.revert([item('GY-1', one), item('GY-3', three)], 'GY-3');
  assert.equal(result.outcome, 'reverted');
  const tip = git(r.repo, 'rev-parse', 'main');
  assert.equal(r.tree(tip), r.tree(direct));
  assert.equal(r.has(tip, 'direct.txt'), true);
});

test('integration:serve-revert-keeps-earlier-reverts — a conflicted revert reports the conflicting paths', async t => {
  const r = await repository('serve-revert-conflict');
  t.after(() => rm(r.base, { recursive: true, force: true }));
  const one = await r.land('GY-1', { 'one.txt': '1\n' });
  await r.write({ 'one.txt': '1 changed later\n' }, 'a direct edit of one.txt');
  const before = git(r.repo, 'rev-parse', 'main');
  const result = await r.revert([item('GY-1', one)], 'GY-1');
  assert.equal(result.outcome, 'held');
  assert.match(result.outcome === 'held' ? result.reason : '', /does not apply cleanly on [0-9a-f]{12}: one\.txt$/);
  assert.equal(git(r.repo, 'rev-parse', 'main'), before);
});
