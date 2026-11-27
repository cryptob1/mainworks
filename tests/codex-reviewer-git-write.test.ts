import { pendingHeadless } from './helpers/pending-review.js';
import { after, before } from 'node:test';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { reviewBindingFile, type ReviewPostBinding } from '../src/review-post.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { setupMaster } from '../src/master.js';
import { WorkerSandboxError } from '../src/worker-sandbox.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { listen } from './helpers/http-server.js';
import { workFixture } from './helpers/work-fixture.js';
import { apiOk } from './helpers/api.js';

// GY-3235: on Huck's install the served repository is not the checkout the CLI release runs from.
// Reviewer launches were confined against the launcher's checkout, so the whole served repository,
// its .git included, was read-only to the sandbox probe and every codex reviewer launch failed
// "cannot write the repository .git". GY-3224 fixed the same for workers only.

const repository = 'owner/project';
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'graphyard-claude-1', role: 'worker' };
const credentials = [coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
// The CLI release lives in this checkout; the served repository is a separate fixture repository.
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, close: (() => Promise<void>) | undefined, url: string;
before(async () => {
  store = await withDatabase('codex-reviewer-git-write'); await store.init();
  ({ url, close } = await listen(server(new Engine(store, 120, repository), credentials)));
});
after(async () => { await close?.(); if (store) await store.close(); });

// The served checkout is the repository itself, or a linked worktree of it whose .git is a pointer file.
for (const layout of ['repository', 'linked-worktree'] as const)
test(`e2e:codex-reviewer-git-write — ${layout}: a codex reviewer launched for a checkout separate from its CLI release passes the confined sandbox probe on the served .git and records its verdict`, async () => {
  const base = await temporaryDirectory('codex-reviewer-git-write');
  const credentialDirectory = await temporaryDirectory('codex-reviewer-credentials');
  try {
    const repo = join(base, 'served-repository');
    const { head: baseSha } = await gitRepo({ root: repo, files: {} });
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'candidate'); const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
    const root = layout === 'repository' ? repo : join(base, 'coordinator');
    if (layout === 'linked-worktree') git(repo, 'worktree', 'add', '-q', '--detach', root);
    await setupMaster(root, { url, token: credentials[0].token, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace-mainworks', run: { worktreeRoot: join(base, 'sessions') } });
    await saveReviewerProfile(root, { name: 'reviewer-codex', agentName: 'review-codex-1', kind: 'codex' });
    const now = new Date().toISOString(), candidate = { sha: head, baseSha, pr: 7, branch: 'graphyard/gy-7-1', author: worker.id };
    const work = workFixture({ id: randomUUID(), key: 'GY-7', title: 'Fixture', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], systemDriven: undefined,
      stage: 'review', revision: 3, createdAt: now, updatedAt: now, stageEnteredAt: now, epoch: 1, candidate, submission: { epoch: 1, pr: 7 }, gates: [], implementers: [worker.id],
      observation: { source: 'control-plane', at: now, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, files: ['src/a.ts'],
        scopeFiles: [{ path: 'src/a.ts', status: 'modified', sha: 'f'.repeat(40), additions: 1, deletions: 0, binary: false }], baseTip: baseSha, baseTipContained: true } } as never);
    await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);

    const probed: string[][] = [], calls: string[][] = [];
    const herdr = (_command: string, args: string[]) => { calls.push(args); return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'tab' ? { type: 'tab_created', root_pane: { pane_id: 'pane-review', tab_id: 'tab-review' }, tab: { tab_id: 'tab-review' } } : args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} }); };
    await launchReview(root, work, 'reviewer-codex', [], now, { probe: registryFixture(hostname(), ['codex'], ['reviewer']).probe, run: herdr, headless: pendingHeadless,
      // The probe runs for real behind the coordinator confinement; only the codex binary, absent here, is left out of it (it runs unsandboxed inside that boundary).
      sandbox: (command, args, options) => {
        assert.match(command, /bwrap$/, 'the reviewer probe runs behind the served repository\'s confinement');
        const inner = args.findIndex((arg, index) => arg === 'codex' && args[index + 1] === 'sandbox');
        assert.ok(inner >= 0, 'the codex sandbox probe runs inside the confinement');
        const shell = [...args.slice(0, inner), ...args.slice(args.indexOf('--', inner) + 1)];
        probed.push(shell);
        return execFileSync(command, shell, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } }).catch(error => { if (error instanceof WorkerSandboxError) assert.fail(`the probe must pass: ${error.message}`); throw error; });
    assert.equal(probed.length, 1);
    assert.ok(probed[0].includes(join(repo, '.git')), 'the served repository\'s .git is a probed, writable path');

    // The session it started posts its verdict with its own launch token, and the control plane records it.
    assert.equal(calls.some(args => args[0] === 'tab'), false);
    const record = (await readReviewLedger(root)).reviews.find(record => record.key === work.key)!;
    const binding = JSON.parse(await readFile(join(record.sessionDirectory, reviewBindingFile), 'utf8')) as ReviewPostBinding;
    await apiOk(url, binding.verdictToken!, `work/${work.id}/review-verdict`, { body: { event: 'APPROVE', body: 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none', sha: head, token: binding.verdictToken } });
    const stored = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document as Work;
    assert.deepEqual(stored.observation!.reviews.map(review => [review.reviewer, review.sha, review.state]), [['review-codex-1', head, 'APPROVED']]);
  } finally { await rm(base, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); }
});
