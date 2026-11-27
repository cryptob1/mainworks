import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { serveGitHttp } from './helpers/git-http-remote.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { defaultChildRun } from '../src/child-runner.js';
import { masterConfigSchema } from '../src/master.js';
import { writeMergeToken } from '../src/install/merge-token.js';

// GY-3220 AC-2: a scratch bare repository served over token-authenticated git smart HTTP on loopback
// (git http-backend behind a Basic-auth server). A token install fetches and pushes through it, a wrong
// token is refused, the token is in no log line, and a deploy-key install still uses origin.

const TOKEN = 'github_pat_fixture_token_value';

async function fixture(label: string) {
  const directory = await temporaryDirectory(label), origin = join(directory, 'repo.git');
  const { root: checkout, head: baseTip } = await gitRepo({ root: join(directory, 'checkout'), files: { 'a.txt': 'base\n' } });
  git(directory, 'init', '-q', '--bare', '-b', 'main', origin); git(origin, 'config', 'http.receivepack', 'true');
  git(checkout, 'remote', 'add', 'origin', origin); git(checkout, 'push', '-q', '-u', 'origin', 'main');
  await writeFile(join(checkout, 'b.txt'), 'merge\n');
  git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'merge');
  const mergeSha = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'reset', '-q', '--hard', baseTip);
  // The checkout's origin is unreachable, so only the explicit URL can work.
  git(checkout, 'remote', 'set-url', 'origin', 'git@127.0.0.1:0/unreachable.git');
  const readsFor = (run: Record<string, unknown>, environment: NodeJS.ProcessEnv) => mergeWriterReads(masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run }),
    checkout, defaultChildRun, { base: join(directory, 'managed'), record: async () => {}, environment });
  return { directory, origin, checkout, baseTip, mergeSha, readsFor };
}

test('e2e:merge-writer-token — a token install fetches and pushes over token-authenticated smart HTTP; a wrong token is refused and no log holds it', { timeout: 120_000 }, async () => {
  const f = await fixture('merge-writer-token-http'), log: string[] = [], server = await serveGitHttp(f.directory, TOKEN, log);
  try {
    const installDir = join(f.directory, 'config', 'owner-project');
    const tokenFile = await writeMergeToken(installDir, TOKEN);
    const env = { PATH: process.env.PATH!, GRAPHYARD_MERGE_WRITER_GIT_URL: server.url };
    const reads = f.readsFor({ mergeWriter: { tokenFile } }, env);
    assert.equal(await reads.fetch(), f.baseTip, 'the fetch reads the base tip over the token URL');
    assert.equal(await reads.push(f.mergeSha, f.baseTip), 'pushed');
    assert.equal(git(f.origin, 'rev-parse', 'main'), f.mergeSha, 'the merge landed on the served repository');

    const wrongFile = await writeMergeToken(join(f.directory, 'wrong'), 'github_pat_wrong');
    const wrong = f.readsFor({ mergeWriter: { tokenFile: wrongFile } }, env);
    const errors: string[] = [];
    await assert.rejects(wrong.fetch(), (error: Error) => { errors.push(error.message); return true; });
    await assert.rejects(wrong.push(f.mergeSha, f.baseTip), (error: Error) => { errors.push(error.message); return true; });
    for (const line of [...log, ...errors]) assert.ok(!line.includes(TOKEN) && !line.includes('github_pat_wrong'), `no log line holds a token: ${line}`);
  } finally { server.close(); }
});

test('integration:merge-writer-token — a deploy-key install still fetches and pushes through origin', { timeout: 60_000 }, async () => {
  const f = await fixture('merge-writer-deploy-key-origin');
  git(f.checkout, 'remote', 'set-url', 'origin', f.origin);
  const reads = f.readsFor({ mergeWriter: { deployKeyFile: join(f.directory, 'unused-key') } }, { PATH: process.env.PATH!, GRAPHYARD_MERGE_WRITER_GIT_URL: 'http://127.0.0.1:1/never.git' });
  assert.equal(await reads.fetch(), f.baseTip);
  assert.equal(await reads.push(f.mergeSha, f.baseTip), 'pushed');
  assert.equal(git(f.origin, 'rev-parse', 'main'), f.mergeSha);
});
