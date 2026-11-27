import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { gitRepo } from './helpers/git-repo.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal, Work } from '../src/model.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { liveRun } from '../src/runner/registry.js';
import type { HeadlessExec } from '../src/headless-session.js';
import { listen } from './helpers/http-server.js';
import { until } from './helpers/until.js';

// GY-3652: setupMaster refuses a managed worktree root on a tmpfs, and a remote shard's /tmp and HOME
// are both tmpfs (its /var/tmp is read-only), so this file names a local-only word and the trial keeps
// it on this machine, where the suite's tmpdir is on disk.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const servePort = 4413, serveUrl = `http://127.0.0.1:${servePort}/healthz`;
let store: Store, close: (() => Promise<void>) | undefined, url: string;
let root: string, credentials: string, base: string, first: string, second: string;

before(async () => {
  store = await withDatabase('parallel-product-reviews-own-ports'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));
  credentials = await temporaryDirectory('parallel-product-reviews-credentials');
  const browserBin = await temporaryDirectory('parallel-product-reviews-browser');
  await writeFile(join(browserBin, 'agent-browser'), '#!/bin/sh\necho browser\n', { mode: 0o755 });
  const repo = await gitRepo({ label: 'parallel-product-reviews-root', files: { 'README.md': 'project\n' } });
  root = repo.root; base = repo.head;
  const commit = (message: string) => { repo.git('add', '.'); repo.git('commit', '-qm', message); return repo.git('rev-parse', 'HEAD'); };
  repo.git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  repo.git('update-ref', 'refs/remotes/origin/main', base);
  // Two heads declaring one serve address: the first binds it, the second serves on the port it is given.
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: { serve: { command: 'node serve-it.mjs', url: serveUrl, readySeconds: 30 } } }, null, 2));
  const serveIt = (marker: string, port: string) => `import { createServer } from 'node:http';
createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<h1>candidate-marker: ${marker}</h1>'); }).listen(${port}, '127.0.0.1');
`;
  await writeFile(join(root, 'serve-it.mjs'), serveIt('first', String(servePort)));
  first = commit('first head');
  await writeFile(join(root, 'serve-it.mjs'), serveIt('second', `Number(process.env.PORT) || ${servePort}`));
  second = commit('second head');
  repo.git('checkout', '-q', base);
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('parallel-product-reviews-checkouts'), reviewerProfile: 'product-claude' } });
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

async function productItem(key: string, head: string): Promise<Work> {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-claude-1' };
  const work = workFixture({ id: randomUUID(), key, title: `Item ${key}`, priority: 1, stage: 'review', revision: 3, epoch: 1,
    criteria: [{ id: 'AC-1', text: 'The feature works for the person using it', proofs: ['integration:parallel-product-reviews-serve-address'] }], createdAt: now(), updatedAt: now(), stageEnteredAt: now(),
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 },
    gates: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['serve-it.mjs'], scopeFiles: [{ path: 'serve-it.mjs', status: 'modified', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true } as never });
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
}
const run = async (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git' || command === 'node') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`no ${command} here`);
};


// GY-3991: two product reviews on one machine run at once, each serving its head where it can. A
// head whose command binds the declared address holds it; another review's head that serves on the
// port it is given gets its own OS-assigned port and starts now, instead of failing with
// 'another product review is serving its head'.

test('integration:parallel-product-reviews-own-ports — two product reviews serve their heads together, each on its own port', async () => {
  const events: string[] = [], pages: Record<string, string> = {}, served: Record<string, string> = {};
  let releaseFirst = () => {};
  const firstHolds = new Promise<void>(resolve => { releaseFirst = resolve; });
  const exec = (name: string): HeadlessExec => async (_command, args, options) => {
    const address = /served for this review at (http:\/\/[^\s]+?) /.exec([...args, options.stdin ?? ''].join(' '))?.[1] ?? '';
    served[name] = address;
    events.push(`${name} started`);
    pages[name] = await fetch(address).then(response => response.text(), () => '');
    // The first session walks its head until the second has started beside it.
    if (name === 'first') await firstHolds;
    events.push(`${name} ended`);
    return `Walked it.\n{"verdict": "APPROVE", "body": "Product reviewed.", "findings": []}`;
  };
  const [one, two] = [await productItem('GY-9990', first), await productItem('GY-9991', second)];
  // The dispatcher's launches: a review that would wait its turn is refused instead.
  const firstLaunch = await launchReview(root, one, 'product-claude', [], now(), { run, headless: exec('first'), product: true, refuseServeTurn: true });
  await until(async () => events.includes('first started'), 'the first session to start', 120_000, 25);
  const secondLaunch = await launchReview(root, two, 'product-claude', [], now(), { run, headless: exec('second'), product: true, refuseServeTurn: true });
  await until(async () => events.includes('second ended'), 'the second session to walk its head', 120_000, 25);
  releaseFirst();
  await until(async () => { const ledger = await readReviewLedger(root); return [firstLaunch, secondLaunch].every(entry => ledger.reviews.some(record => record.id === entry.review && !liveRun(record.agentName) && !!record.verdict)); }, 'both review runs to end', 120_000, 25);
  assert.deepEqual(events, ['first started', 'second started', 'second ended', 'first ended'], 'the second review ran while the first was serving');
  assert.equal(new URL(served.first).port, String(servePort), 'the first head binds the declared address');
  assert.notEqual(new URL(served.second).port, String(servePort), 'the second head serves on its own port');
  assert.match(pages.first, /candidate-marker: first/, 'the first session walked its own head');
  assert.match(pages.second, /candidate-marker: second/, 'the second session walked its own head');
});

test('unit:parallel-product-reviews-own-ports-pinned — this file never goes to a remote shard, whose tmpfs refuses the review checkouts', async () => {
  const { remoteableTestFile } = await import('../src/merge-writer/remote-shards.js');
  assert.equal(remoteableTestFile(await readFile(new URL(import.meta.url), 'utf8')), false);
});
