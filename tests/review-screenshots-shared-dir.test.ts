import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';
import { gitRepo } from './helpers/git-repo.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal, Work } from '../src/model.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { ReviewPostRefusal, screenshotUploads } from '../src/review-post.js';
import { liveRun } from '../src/runner/registry.js';
import type { HeadlessExec } from '../src/headless-session.js';
import { listen } from './helpers/http-server.js';

// GY-3590: a headless product reviewer's sandbox keeps its own /tmp and home, so a screenshot saved
// there cannot be read by the launcher posting its verdict. Each such session is named one
// screenshot directory both sides see; a bare "Screenshot: NAME" resolves against it.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP438AAAAQBAYDFKhhdAAAAAElFTkSuQmCC', 'base64');
let store: Store, close: (() => Promise<void>) | undefined, url: string;
let root: string, credentials: string, base: string, head: string;

before(async () => {
  store = await withDatabase('review-screenshots-shared-dir'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));
  root = await temporaryDirectory('review-screenshots-root'); credentials = await temporaryDirectory('review-screenshots-credentials');
  const browserBin = await temporaryDirectory('review-screenshots-browser');
  await writeFile(join(browserBin, 'agent-browser'), '#!/bin/sh\necho browser\n', { mode: 0o755 });
  const repo = await gitRepo({ root, files: { 'README.md': 'Named spec file.\n' } }), git = repo.git;
  base = repo.head;
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'page.html'), '<h1>Settings</h1>\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'ui change');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('review-screenshots-checkouts', join(process.cwd(), '.graphyard')), reviewerProfile: 'product-claude' } });
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'opus', id: 'opus' }],
    accounts: [{ name: 'product-claude-account', runtime: 'claude', model: 'opus', credential: { host: config.hostId, home: null } }],
    roles: [{ name: 'reviewer', accounts: ['product-claude-account'], concurrency: 4, policy: {} }], reason: 'review screenshots fixture' }, randomUUID());
  await saveReviewerProfile(root, { name: 'product-claude', agentName: 'product-claude-1', kind: 'claude', agentArgs: [], accounts: ['product-claude-account'] });
  process.env.PATH = `${browserBin}:${process.env.PATH ?? ''}`;
});
after(async () => {
  await close?.();
  if (store) await store.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (credentials) await rm(credentials, { recursive: true, force: true });
});

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
async function insertItem(key: string): Promise<Work> {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  const work = workFixture({ id: randomUUID(), key, title: `Item ${key}`, priority: 1, stage: 'review', revision: 3, epoch: 1,
    criteria: [{ id: 'AC-1', text: 'The settings page shows its title', proofs: ['e2e:settings'] }], createdAt: now(), updatedAt: now(), stageEnteredAt: now(),
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 },
    gates: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['page.html'], scopeFiles: [{ path: 'page.html', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } as never });
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
}
const run = (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`no ${command} here`);
};
/**
 * A sandboxed runtime double: it saves its screenshot in the directory its request names — or, with
 * none named, in its own working directory, as agy and opencode saved under their private /tmp — and
 * lists it by bare file name.
 */
function sandboxedReviewer() {
  const runs: string[] = [];
  const exec: HeadlessExec = async (_command, args, options) => {
    const prompt = args.at(-1)!;
    runs.push(prompt);
    const named = /save each screenshot in (\S+?) —/i.exec(prompt)?.[1];
    const directory = named ?? join(options.cwd, 'private-tmp');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'settings.png'), png);
    return `{"verdict": "APPROVE", "body": "Product reviewed head ${head} against base ${base}. AC-1 met.\\nScreenshot: settings.png", "findings": []}`;
  };
  return { exec, runs };
}
const settledRecord = async (id: string) => {
  for (let tries = 0; tries < 400; tries++) {
    const record = (await readReviewLedger(root)).reviews.find(entry => entry.id === id && !liveRun(entry.agentName) && (entry.verdict || entry.state !== 'pending'));
    if (record) return record;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return assert.fail('timed out waiting for the review run to end');
};

test('integration:review-screenshots-shared-dir — a screenshot saved in the directory the request names posts with the verdict; an unreadable path outside it is still refused', async () => {
  const work = await insertItem('GY-9590');
  const fake = sandboxedReviewer();
  const launched = await launchReview(root, work, 'product-claude', [], now(), { run, headless: fake.exec, product: true });
  const record = await settledRecord(launched.review);
  assert.doesNotMatch(record.resolution ?? '', /cannot be read/, 'the launcher reads the screenshot the sandboxed session saved');
  assert.equal(record.verdict?.state, 'APPROVED', record.resolution);
  assert.match(fake.runs[0]!, /Screenshot: NAME/, 'the request asks for the bare file name');
  const reviewed = await stored(work.id);
  assert.equal(reviewed.productReview?.verdict, 'approved');
  assert.deepEqual(reviewed.productReview?.screenshots, ['settings.png'], 'the verdict carries the uploaded image');
  // A path outside that directory that cannot be read is refused with the existing message.
  await assert.rejects(screenshotUploads('Screenshot: /tmp/opencode/nowhere-9590/shot.png', undefined, join(launched.checkout!, 'screenshots')), (error: Error) =>
    error instanceof ReviewPostRefusal && error.message === 'Screenshot /tmp/opencode/nowhere-9590/shot.png cannot be read; name the file you saved, by its path');
});

test('e2e:review-screenshots-shared-dir — a product review of a UI change ends with a posted verdict whose screenshots show on the item page', async () => {
  const work = await insertItem('GY-9591');
  const launched = await launchReview(root, work, 'product-claude', [], now(), { run, headless: sandboxedReviewer().exec, product: true });
  const record = await settledRecord(launched.review);
  assert.equal(record.verdict?.state, 'APPROVED', record.resolution);
  const reviewed = await stored(work.id);
  assert.deepEqual(reviewed.productReview?.screenshots, ['settings.png']);
  // The item page's product-review panel reads each screenshot from this route.
  const served = await fetch(`${url}/api/work/${work.id}/product-review/screenshots/settings.png`, { headers: { Authorization: `Bearer ${coordinatorToken}` } });
  assert.deepEqual([served.status, served.headers.get('content-type')], [200, 'image/png']);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png, 'the item page shows exactly the image the reviewer saved');
});
