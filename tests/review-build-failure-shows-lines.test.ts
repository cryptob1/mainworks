import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
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
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { liveRun } from '../src/runner/registry.js';
import { freePort } from '../src/serve-app.js';
import type { HeadlessExec } from '../src/headless-session.js';
import { listen } from './helpers/http-server.js';
import { workFixture } from './helpers/work-fixture.js';
import { until } from './helpers/until.js';

// GY-3999: a product review whose build fails records the last 40 lines of the build's output,
// stderr included, on the item — not npm's notice lines.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let servePort: number;
let store: Store, close: (() => Promise<void>) | undefined, url: string;
let root: string, credentials: string, base: string, built: string, broken: string;

before(async () => {
  servePort = await freePort();
  store = await withDatabase('review-build-failure-shows-lines'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));
  root = await temporaryDirectory('review-build-lines-root'); credentials = await temporaryDirectory('review-build-lines-credentials');
  const browserBin = await temporaryDirectory('review-build-lines-browser');
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
  await writeFile(join(root, 'build.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<h1>dashboard-marker: built by the head</h1>');
`);
  built = commit('a UI change');
  // 50 compile errors on stderr, then the 20 notice lines npm prints after a failed script.
  await writeFile(join(root, 'build.mjs'), `for (let n = 1; n <= 50; n++) console.error('compile-error-' + n + ': src/app.ts does not compile');
for (let n = 1; n <= 20; n++) console.error('npm notice ' + n + ': a new version of npm is available');
process.exit(1);
`);
  broken = commit('a broken build');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  // The repository's install is current (nothing to install); the managed checkouts live outside it.
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('review-build-lines-checkouts'), reviewerProfile: 'product-claude' } });
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
    criteria: [{ id: 'AC-1', text: 'The dashboard answers', proofs: ['integration:review-build-failure-shows-lines'] }], stage: 'review', revision: 3, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), epoch: 1,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, gates: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['build.mjs'], scopeFiles: [{ path: 'build.mjs', status: 'modified', sha: head, additions: 1, deletions: 1, binary: false }], baseTip: base, baseTipContained: true } });
}
// The launch's commands run as themselves: git, and the repository's build.
const run = async (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  if (command === 'npm' && args[0] === 'run') return await promisify(execFile)('npm', args, { cwd: options!.cwd, encoding: 'utf8' }).then(result => result.stdout);
  throw new Error(`no ${command} ${args.join(' ')} here`);
};

test('integration:review-build-failure-shows-lines — a failed review build records its last 40 lines, stderr included, on the item', async () => {
  const work = productItem('GY-9991', broken);
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  await assert.rejects(launchReview(root, work, 'product-claude', [], now(), { run, headless: async () => '', product: true }), /npm run build failed in the review checkout/);
  const { rows } = await store.pool.query('SELECT document FROM work_items WHERE id = $1', [work.id]);
  const review = rows[0].document.productReview;
  assert.equal(review?.verdict, 'could-not-run', 'the failed build is recorded on the item');
  assert.equal(review.sha, broken);
  const findings: string = review.findings;
  assert.match(findings, /npm run build failed in the review checkout of [0-9a-f]{12}/);
  for (let n = 11; n <= 50; n++) assert.ok(findings.includes(`compile-error-${n}: src/app.ts does not compile`), `line ${n} of the build's stderr is recorded: ${findings}`);
  assert.ok(!findings.includes('compile-error-10:'), 'only the last 40 lines are kept');
  assert.ok(!/npm notice/.test(findings), 'npm notice lines are not what is recorded');
});
