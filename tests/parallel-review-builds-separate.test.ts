import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

// GY-3999: two product reviews building different heads at once on one machine build with their
// own temporary and cache directories, so neither build reads or overwrites the other's.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, close: (() => Promise<void>) | undefined, url: string;
let root: string, credentials: string, rendezvous: string, base: string, first: string, second: string;

before(async () => {
  store = await withDatabase('parallel-review-builds-separate'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));
  root = await temporaryDirectory('parallel-review-build-root'); credentials = await temporaryDirectory('parallel-review-build-credentials');
  const browserBin = await temporaryDirectory('parallel-review-build-browser');
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
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve-it.mjs', url: 'http://127.0.0.1:4999/healthz', readySeconds: 30 } } }, null, 2));
  // Each head's build leaves its mark in its temporary directory and caches, waits until the other
  // head's build is running, and fails when its mark was overwritten: a cache the two builds share.
  rendezvous = await temporaryDirectory('parallel-review-build-rendezvous');
  const build = (label: string) => `import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const label = ${JSON.stringify(label)}, rendezvous = ${JSON.stringify(rendezvous)};
const places = [tmpdir(), process.env.XDG_CACHE_HOME, process.env.npm_config_cache];
writeFileSync(join(rendezvous, label + '.json'), JSON.stringify(places));
const marks = places.filter(Boolean).map(place => join(place, 'review-build-mark'));
for (const mark of marks) { mkdirSync(place(mark), { recursive: true }); writeFileSync(mark, label); }
function place(mark) { return mark.slice(0, mark.lastIndexOf('/')); }
const until = Date.now() + 30000;
while (readdirSync(rendezvous).filter(name => name.endsWith('.json')).length < 2) {
  if (Date.now() > until) { console.error('the other build never started'); process.exit(1); }
  await new Promise(done => setTimeout(done, 50));
}
await new Promise(done => setTimeout(done, 300));
for (const mark of marks) if (readFileSync(mark, 'utf8') !== label) { console.error('shared-cache: ' + mark + ' was written by the other build'); process.exit(1); }
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<h1>dashboard-marker: ' + label + '</h1>');
`;
  await writeFile(join(root, 'build.mjs'), build('base'));
  base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'build.mjs'), build('first-head'));
  first = commit('the first head');
  await writeFile(join(root, 'build.mjs'), build('second-head'));
  second = commit('the second head');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  // The repository's install is current (nothing to install); the managed checkouts live outside it.
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('parallel-review-build-checkouts'), reviewerProfile: 'product-claude' } });
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
  if (rendezvous) await rm(rendezvous, { recursive: true, force: true });
});

function productItem(key: string, head: string): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'graphyard-claude-1' };
  return workFixture({ id: randomUUID(), key, title: `Item ${key}`, priority: 1,
    criteria: [{ id: 'AC-1', text: 'The dashboard answers', proofs: ['integration:parallel-review-builds-separate'] }], stage: 'review', revision: 3, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), epoch: 1,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 }, gates: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['build.mjs'], scopeFiles: [{ path: 'build.mjs', status: 'modified', sha: head, additions: 1, deletions: 1, binary: false }], baseTip: base, baseTipContained: true } });
}
// The launch's commands run as themselves: git, and the repository's build.
const run = async (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  if (command === 'npm' && args[0] === 'run') return await promisify(execFile)('npm', args, { cwd: options!.cwd, env: options!.env, encoding: 'utf8' }).then(result => result.stdout);
  throw new Error(`no ${command} ${args.join(' ')} here`);
};

test('integration:parallel-review-builds-separate — two reviews building different heads at once use separate build output and cache directories, and both succeed', async () => {
  const items = [productItem('GY-9992', first), productItem('GY-9993', second)];
  for (const work of items) await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  const pages = new Map<string, string>();
  const exec = (head: string): HeadlessExec => async (_command, _args, options) => {
    // The session runs in its review directory; the head's built dashboard is in its checkout.
    pages.set(head, await readFile(join(options.cwd, 'checkout', 'dist', 'index.html'), 'utf8').catch(() => ''));
    return `Walked it.\n{"verdict": "APPROVE", "body": "Product reviewed head ${head} against base ${base}.", "findings": []}`;
  };
  const launched = await Promise.all(items.map(work => launchReview(root, work, 'product-claude', [], now(), { run, headless: exec(work.candidate!.sha), product: true })));
  await until(async () => (await readReviewLedger(root)).reviews.filter(record => launched.some(launch => launch.review === record.id) && !liveRun(record.agentName) && !!record.verdict).length === 2, 'both review runs to end', 20_000, 25);
  const places = await Promise.all(['first-head', 'second-head'].map(async label => JSON.parse(await readFile(join(rendezvous, `${label}.json`), 'utf8')) as (string | null)[]));
  for (const [index, name] of ['temporary directory', 'XDG cache', 'npm cache'].entries()) {
    assert.ok(places[0][index] && places[1][index], `both builds name a ${name}: ${JSON.stringify(places)}`);
    assert.notEqual(places[0][index], places[1][index], `the two builds share one ${name}`);
  }
  assert.notEqual(launched[0].checkout, launched[1].checkout, 'each review has its own checkout, and with it its own dist/');
  assert.match(pages.get(first) ?? '', /dashboard-marker: first-head/, 'the first review served its own build');
  assert.match(pages.get(second) ?? '', /dashboard-marker: second-head/, 'the second review served its own build');
});
