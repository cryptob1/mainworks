import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal, Work } from '../src/model.js';
import { launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { freePort } from '../src/serve-app.js';
import { listen } from './helpers/http-server.js';
import { runChild } from '../src/child-runner.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-4012: a product review build killed without printing anything — by a signal or by the review
// timeout — still says why on the item: the signal or exit code, whether the timeout fired, its
// elapsed seconds, and 'no output'.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let servePort: number;
let store: Store, close: (() => Promise<void>) | undefined, url: string;
let root: string, credentials: string, base: string, killed: string, hung: string;

before(async () => {
  servePort = await freePort();
  store = await withDatabase('review-build-killed-says-why'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));
  root = await temporaryDirectory('review-build-killed-root'); credentials = await temporaryDirectory('review-build-killed-credentials');
  const browserBin = await temporaryDirectory('review-build-killed-browser');
  await writeFile(join(browserBin, 'agent-browser'), '#!/bin/sh\necho browser\n', { mode: 0o755 });
  const { git } = await gitRepo({ root });
  const commit = (message: string) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  // The build's output is untracked, as the repository's dist/ is.
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'project', version: '1.0.0', scripts: { build: 'node build.mjs' } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'project', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'project', version: '1.0.0' } } }));
  // The served app answers its dashboard from dist/, and 500 when dist/ was never built.
  await writeFile(join(root, 'serve-it.mjs'), `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((request, response) => {
  if (request.url?.startsWith('/healthz')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return; }
  try { const page = readFileSync('dist/index.html', 'utf8'); response.writeHead(200, { 'content-type': 'text/html' }); response.end(page); }
  catch { response.writeHead(500); response.end('dist/index.html is missing'); }
}).listen(${servePort}, '127.0.0.1');
`);
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve-it.mjs', url: `http://127.0.0.1:${servePort}/healthz`, readySeconds: 30 } } }, null, 2));
  await writeFile(join(root, 'build.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<h1>dashboard-marker: built</h1>');
`);
  base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  // A build the machine kills before it prints a line.
  await writeFile(join(root, 'build.mjs'), `process.kill(process.pid, 'SIGKILL');\n`);
  killed = commit('a build killed by SIGKILL');
  // A build that hangs silently until the review timeout kills it.
  await writeFile(join(root, 'build.mjs'), `setInterval(() => {}, 1000);\n`);
  hung = commit('a build that never finishes');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  // The repository's install is current (nothing to install); the managed checkouts live outside it.
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('review-build-killed-checkouts'), reviewerProfile: 'product-claude' } });
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'opus', id: 'opus' }],
    accounts: [{ name: 'product-claude-account', runtime: 'claude', model: 'opus', credential: { host: config.hostId, home: null } }],
    roles: [{ name: 'reviewer', accounts: ['product-claude-account'], concurrency: 8, policy: {} }], reason: 'fixture' }, randomUUID());
  await saveReviewerProfile(root, { name: 'product-claude', agentName: 'product-claude-1', kind: 'claude', agentArgs: [], accounts: ['product-claude-account'] });
  process.env.PATH = `${browserBin}:${process.env.PATH ?? ''}`;
});
after(async () => {
  await close?.();
  if (store) await store.close();
  if (root) await rm(root, { recursive: true, force: true });
  if (credentials) await rm(credentials, { recursive: true, force: true });
});

function productItem(key: string, head: string): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return workFixture({ id: randomUUID(), key, title: `Item ${key}`, priority: 1,
    criteria: [{ id: 'AC-1', text: 'The dashboard answers', proofs: ['integration:review-build-killed-says-why'] }], stage: 'review', revision: 3, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), epoch: 1,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, gates: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['build.mjs'], scopeFiles: [{ path: 'build.mjs', status: 'modified', sha: head, additions: 1, deletions: 1, binary: false }], baseTip: base, baseTipContained: true } });
}
// The launch's commands run as themselves: git, and the repository's build run directly (so the
// signal reaches the stand-in build, not npm) under a 2-second stand-in for the review timeout.
const run = async (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  if (command === 'npm' && args[0] === 'run') return await runChild('node', ['build.mjs'], { cwd: options!.cwd, env: options?.env, timeoutMs: 2_000 });
  throw new Error(`no ${command} ${args.join(' ')} here`);
};

async function failedReview(key: string, head: string): Promise<string> {
  const work = productItem(key, head);
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  await assert.rejects(launchReview(root, work, 'product-claude', [], now(), { run, headless: async () => '', product: true }), /npm run build failed in the review checkout/);
  const { rows } = await store.pool.query('SELECT document FROM work_items WHERE id = $1', [work.id]);
  const review = rows[0].document.productReview;
  assert.equal(review?.verdict, 'could-not-run', 'the failed build is recorded on the item');
  assert.equal(review.sha, head);
  return review.findings;
}

test('integration:review-build-killed-says-why — a build killed by SIGKILL without output records the signal, no timeout, elapsed seconds and no output', async () => {
  const findings = await failedReview('GY-9981', killed);
  assert.match(findings, /npm run build failed in the review checkout of [0-9a-f]{12}/);
  assert.match(findings, /killed by SIGKILL/, findings);
  assert.match(findings, /review timeout fired: no/, findings);
  assert.match(findings, /elapsed \d+ s/, findings);
  assert.match(findings, /no output/, findings);
});

test('integration:review-build-killed-says-why — a build the review timeout kills records the signal, that the timeout fired, elapsed seconds and no output', async () => {
  const findings = await failedReview('GY-9982', hung);
  assert.match(findings, /killed by SIGTERM/, findings);
  assert.match(findings, /review timeout fired: yes/, findings);
  const elapsed = Number(/elapsed (\d+) s/.exec(findings)?.[1]);
  assert.ok(elapsed >= 2, `elapsed seconds cover the 2-second timeout: ${findings}`);
  assert.match(findings, /no output/, findings);
});
