import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork, setupMaster, type WorkerProfile } from '../src/master.js';
import { preservePartialWork } from '../src/master/launch.js';
import { recordLoopOwner } from '../src/check-in-author.js';
import { mergeSubject, trialMerge, trialAuthor } from '../src/merge-writer/trial.js';
import { revertMergeCommit } from '../src/merge-writer/serve-revert.js';
import { completePreflight } from '../src/cli/complete.js';
import type { Work } from '../src/model.js';
import { recordedRuns } from './helpers/headless-runs.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3850: with the owner recorded, every commit on the install — a worker session's, the kept
// work-in-progress, the merge writer's merge and revert — is authored 'NAME (Mainworks) <EMAIL>',
// while the committer stays the agent identity every gate reads. complete refuses another author.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const owner = { name: 'Ada Lovelace', email: 'ada@example.com' };
const ownerAuthor = 'Ada Lovelace (Mainworks) <ada@example.com>';
const agent = 'graphyard-codex-9';
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name)));
const show = (root: string, format: string, sha = 'HEAD') => execFileSync('git', ['-C', root, 'show', '-s', `--format=${format}`, sha], { encoding: 'utf8' }).trim();
const gitIn = (root: string) => async (args: string[], env?: Record<string, string>) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...clean, ...env } });

function work(key: string): Work {
  const at = new Date().toISOString();
  return { id: `id-${key}`, key, title: 'Name the owner', description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as unknown as Work;
}

/** A repository whose own git config is the agent identity, as a worker's checkout is. */
async function repository(label: string) {
  const root = await temporaryDirectory(label);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: clean });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', agent); git('config', 'user.email', `${agent}@users.noreply.invalid`); git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'a.txt'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
  return { root, git };
}

test('integration:check-ins-are-authored-owner-and-mainworks — worker, kept-work, merge and revert commits carry the owner author; the committer stays the agent; complete refuses another author', async () => {
  recordLoopOwner(owner);
  try {
    const { root, git } = await repository('check-in-author');
    const base = git('rev-parse', 'HEAD').trim();

    // A worker session launched by the loop: its environment authors as the owner, its committer is the agent identity.
    const credentialDirectory = await temporaryDirectory('check-in-author-credentials');
    const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
    git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
    await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main' }))) as typeof fetch);
    const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
    const worker = recordedRuns(), item = work('GY-77');
    await dispatchWork(root, item, profile, { allWork: [item], prepare: async () => ({ epoch: 1, path: root, base: 'c'.repeat(40) }), release: async () => {}, observedAt: new Date().toISOString(), headless: worker.exec, probe: registryFixture(hostname(), ['codex']).probe });
    const session = worker.runs[0]!.env;
    git('checkout', '-qb', 'graphyard/gy-77-1');
    await writeFile(join(root, 'b.txt'), 'worker\n');
    execFileSync('git', ['-C', root, 'add', '-A'], { env: session });
    execFileSync('git', ['-C', root, 'commit', '-qm', 'GY-77: the worker change'], { env: session });
    assert.equal(show(root, '%an <%ae>'), ownerAuthor, 'the worker commit is authored by the owner');
    assert.equal(show(root, '%cn'), agent, 'the worker commit is committed by the agent identity');

    // The loop's kept work-in-progress commit.
    await writeFile(join(root, 'c.txt'), 'unfinished\n');
    const kept = await preservePartialWork(root, 'GY-77 attempt 1 expired');
    assert.equal(kept.state, 'committed');
    assert.equal(show(root, '%an <%ae>'), ownerAuthor, 'the kept work is authored by the owner');
    assert.equal(show(root, '%cn'), 'Mainworks', 'the kept work keeps its committer');
    const head = git('rev-parse', 'HEAD').trim();

    // The base moves on, so the merge writer makes a merge commit: owner author, merge-writer committer, the subject's form unchanged.
    git('checkout', '-q', 'main');
    await writeFile(join(root, 'd.txt'), 'main moved\n'); git('add', '-A'); git('commit', '-qm', 'main moves');
    const baseTip = git('rev-parse', 'HEAD').trim();
    const merged = await trialMerge(gitIn(root), { head, baseTip, subject: mergeSubject(item) });
    assert.ok('mergeSha' in merged);
    assert.equal(show(root, '%an <%ae>', merged.mergeSha), ownerAuthor, 'the merge commit is authored by the owner');
    assert.equal(show(root, '%cn <%ce>', merged.mergeSha), `${trialAuthor} <${trialAuthor}@users.noreply.invalid>`, 'the merge writer stays the committer');
    assert.equal(show(root, '%s', merged.mergeSha), 'Merge GY-77: Name the owner');

    // The revert of that landing: owner author, merge-writer committer.
    const reverted = await revertMergeCommit(gitIn(root), { mergeSha: merged.mergeSha, before: baseTip, baseTip: merged.mergeSha, subject: 'Merge GY-77: Name the owner' });
    assert.ok('revertSha' in reverted);
    assert.equal(show(root, '%an <%ae>', reverted.revertSha), ownerAuthor, 'the revert commit is authored by the owner');
    assert.equal(show(root, '%cn', reverted.revertSha), trialAuthor);

    // complete: a head of owner-authored commits passes; one carrying another author is refused in one line naming the commit and the author it must have.
    git('update-ref', 'refs/remotes/origin/main', base);
    await completePreflight(root, { key: 'GY-77' }, head, { owner });
    git('checkout', '-q', head);
    await writeFile(join(root, 'e.txt'), 'by hand\n'); git('add', '-A'); git('commit', '-qm', 'another author');
    const foreign = git('rev-parse', 'HEAD').trim();
    await assert.rejects(completePreflight(root, { key: 'GY-77' }, foreign, { owner }), (error: Error) => {
      assert.equal(error.message.split('\n').length, 1);
      assert.match(error.message, new RegExp(`^complete refused: commit ${foreign.slice(0, 12)} is authored '${agent}'; every commit must be authored '${ownerAuthor.replace(/[()]/g, '\\$&')}'`));
      return true;
    });
    // The line's own fix makes the head acceptable.
    execFileSync('git', ['-C', root, 'rebase', '-q', base, '--exec', 'git commit -q --amend --no-edit --reset-author'], { env: { ...clean, GIT_AUTHOR_NAME: 'Ada Lovelace (Mainworks)', GIT_AUTHOR_EMAIL: owner.email } });
    await completePreflight(root, { key: 'GY-77' }, git('rev-parse', 'HEAD').trim(), { owner });

    // With no owner recorded, Mainworks authors as 'Mainworks <mainworks@localhost>'.
    recordLoopOwner(null);
    const unowned = await trialMerge(gitIn(root), { head, baseTip, subject: mergeSubject(item) });
    assert.ok('mergeSha' in unowned);
    assert.equal(show(root, '%an <%ae>', unowned.mergeSha), 'Mainworks <mainworks@localhost>');
  } finally { recordLoopOwner(null); }
});
