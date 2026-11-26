import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork, setupMaster, type WorkerProfile } from '../src/master.js';
import { mergeSubject, trialMerge } from '../src/merge-writer/trial.js';
import { revertMergeCommit } from '../src/merge-writer/serve-revert.js';
import { completePreflight } from '../src/cli/complete.js';
import { ensureDeployKey } from '../src/install/deploy-key.js';
import type { GitHubCli } from '../src/install/github.js';
import type { Work } from '../src/model.js';
import { recordedRuns } from './helpers/headless-runs.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3872: the merge writer, the workers and the deploy key say Mainworks; history, in-flight
// branches and keys made under the old 'graphyard-' names still pass and are left in place.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const oldWorker = 'graphyard-codex-9';
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name)));
const show = (root: string, format: string, sha = 'HEAD') => execFileSync('git', ['-C', root, 'show', '-s', `--format=${format}`, sha], { encoding: 'utf8' }).trim();
const gitIn = (root: string) => async (args: string[], env?: Record<string, string>) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...clean, ...env } });

function work(key: string): Work {
  return workFixture({ key, title: 'Say Mainworks', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }] });
}

function openSshPublicKey(comment: string) {
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const field = (value: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(value.length); return Buffer.concat([length, value]); };
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64')} ${comment}`;
}

/** A fake gh holding the repository's deploy keys; `add` appends one. */
function github(keys: { id: number; key: string; title: string }[]): GitHubCli {
  return async args => {
    if (args[1] === 'deploy-key' && args[2] === 'list') return { stdout: JSON.stringify(keys), stderr: '', code: 0 };
    if (args[1] === 'deploy-key' && args[2] === 'add') { keys.push({ id: keys.length + 1, key: (await readFile(args[3]!, 'utf8')).trim(), title: args[args.indexOf('--title') + 1]! }); return { stdout: '', stderr: '', code: 0 }; }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}

test('integration:committer-and-key-names-say-mainworks — a new merge, revert and worker commit are committed by mainworks- names, a branch of old-name commits still merges and completes, and a new deploy key is titled mainworks-merge-writer-<host> while an old-titled key is kept, not duplicated', async () => {
  // A checkout whose git config is an old worker identity, as in-flight branches made before the change are.
  const root = await temporaryDirectory('mainworks-names');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: clean });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', oldWorker); git('config', 'user.email', `${oldWorker}@users.noreply.invalid`); git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'a.txt'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  git('update-ref', 'refs/remotes/origin/main', base);

  // A branch made before the change: its commits are committed by the old worker name.
  git('checkout', '-qb', 'graphyard/gy-78-1');
  await writeFile(join(root, 'b.txt'), 'old worker\n'); git('add', '-A'); git('commit', '-qm', 'GY-78: made before the rename');
  const oldHead = git('rev-parse', 'HEAD').trim();
  assert.equal(show(root, '%cn'), oldWorker);

  // A worker launched now commits as mainworks-<identity>.
  const credentialDirectory = await temporaryDirectory('mainworks-names-credentials');
  const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await setupMaster(root, { url: 'https://mainworks.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main' }))) as typeof fetch);
  const profile: WorkerProfile = { name: 'launch', principal: 'graphyard-codex-9', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
  const worker = recordedRuns(), item = work('GY-78');
  await dispatchWork(root, item, profile, { allWork: [item], prepare: async () => ({ epoch: 1, path: root, base: 'c'.repeat(40) }), release: async () => {}, observedAt: new Date().toISOString(), headless: worker.exec, probe: registryFixture(hostname(), ['codex']).probe });
  const session = worker.runs[0]!.env;
  await writeFile(join(root, 'c.txt'), 'new worker\n');
  execFileSync('git', ['-C', root, 'add', '-A'], { env: session });
  execFileSync('git', ['-C', root, 'commit', '-qm', 'GY-78: made after the rename'], { env: session });
  assert.equal(show(root, '%cn <%ce>'), 'mainworks-codex-9 <mainworks-codex-9@users.noreply.invalid>', 'a new worker commit is committed by a mainworks- identity');
  const head = git('rev-parse', 'HEAD').trim();

  // The branch, old-name commits and all, completes.
  await completePreflight(root, { key: 'GY-78' }, oldHead, {});
  await completePreflight(root, { key: 'GY-78' }, head, {});

  // The base moves; the merge writer merges the branch and commits as mainworks-merge-writer.
  git('checkout', '-q', 'main');
  await writeFile(join(root, 'd.txt'), 'main moved\n'); git('add', '-A'); git('commit', '-qm', 'main moves');
  const baseTip = git('rev-parse', 'HEAD').trim();
  const merged = await trialMerge(gitIn(root), { head, baseTip, subject: mergeSubject(item) });
  assert.ok('mergeSha' in merged, JSON.stringify(merged));
  assert.equal(show(root, '%cn <%ce>', merged.mergeSha), 'mainworks-merge-writer <mainworks-merge-writer@users.noreply.invalid>');
  assert.equal(show(root, '%s', merged.mergeSha), 'Merge GY-78: Say Mainworks');
  // A branch holding only old-name commits merges too.
  const mergedOld = await trialMerge(gitIn(root), { head: oldHead, baseTip, subject: mergeSubject(item) });
  assert.ok('mergeSha' in mergedOld, JSON.stringify(mergedOld));
  assert.equal(show(root, '%cn', mergedOld.mergeSha), 'mainworks-merge-writer');

  const reverted = await revertMergeCommit(gitIn(root), { mergeSha: merged.mergeSha, before: baseTip, baseTip: merged.mergeSha, subject: 'Merge GY-78: Say Mainworks' });
  assert.ok('revertSha' in reverted, JSON.stringify(reverted));
  assert.equal(show(root, '%cn', reverted.revertSha), 'mainworks-merge-writer');

  // The deploy key: a new one is titled mainworks-merge-writer-<host>.
  const keygen = async (args: string[]) => {
    const file = args[args.indexOf('-f') + 1]!;
    await writeFile(file, 'placeholder private key\n', { mode: 0o600 });
    await writeFile(`${file}.pub`, `${openSshPublicKey(args[args.indexOf('-C') + 1]!)}\n`, { mode: 0o600 });
    return { stdout: '', stderr: '', code: 0 };
  };
  const fresh = await temporaryDirectory('mainworks-names-key');
  const keys: { id: number; key: string; title: string }[] = [];
  await ensureDeployKey(fresh, 'owner/project', github(keys), { keygen, hostname: 'box' });
  assert.deepEqual(keys.map(entry => entry.title), ['mainworks-merge-writer-box']);
  assert.match(await readFile(join(fresh, 'deploy-key.pub'), 'utf8'), / mainworks-merge-writer-box\n$/);

  // An install whose key was registered under the old title keeps it: recognised, left in place, never added again.
  const existing = await temporaryDirectory('mainworks-names-old-key');
  const oldKey = openSshPublicKey('graphyard-merge-writer-box');
  await writeFile(join(existing, 'deploy-key'), 'placeholder private key\n', { mode: 0o600 });
  await writeFile(join(existing, 'deploy-key.pub'), `${oldKey}\n`, { mode: 0o600 });
  const listed = [{ id: 7, key: oldKey.split(' ').slice(0, 2).join(' '), title: 'graphyard-merge-writer-box' }];
  await ensureDeployKey(existing, 'owner/project', github(listed), { keygen: async () => { throw new Error('no key is generated for an install that has one'); }, hostname: 'box' });
  assert.deepEqual(listed.map(entry => [entry.id, entry.title]), [[7, 'graphyard-merge-writer-box']]);
});
