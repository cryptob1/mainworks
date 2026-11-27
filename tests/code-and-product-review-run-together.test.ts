import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { useTestStore } from './helpers/test-store.js';
import { Store } from '../src/store.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { tokenRegistered } from '../src/server/review-verdict.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { saveReviewerProfile, controlPlaneVerdict } from '../src/reviewer.js';
import { serveReviewHead } from '../src/review-serve.js';
import { emptyRegistry, settleSessions, type FleetSession } from '../src/model/registry.js';
import { freePort } from '../src/serve-app.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';
import { observationFixture } from './helpers/observation-fixture.js';
import { api } from './helpers/api.js';

const H = 'a'.repeat(40), B = 'b'.repeat(40);
const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const freshToken = () => randomBytes(32).toString('hex');
const now = () => new Date().toISOString();

const repository = 'owner/project';
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'graphyard-claude-1', role: 'worker' };
const credentials = [coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const tokenOf = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let store: Store, http: ReturnType<typeof server>, url: string;
useTestStore('code-and-product-review-run-together', { repository, credentials }, ctx => { ({ store, http, url } = ctx); });

const post = (credential: string, path: string, body?: unknown, key?: string) => api(url, credential, path, { method: 'POST', body, key });
const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
const launchBody = (token: string, fields: Record<string, unknown> = {}) => ({
  reviewer: 'review-claude-1',
  head: H,
  baseTip: B,
  tokenHash: hashOf(token),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  ...fields,
});

function featureItem(key: string, files = ['src/store/pools.ts', 'src/web/board.ts']): Work {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: worker.id };
  const work = workFixture({
    id: randomUUID(),
    key,
    type: 'feature',
    title: `Feature ${key}`,
    priority: 1,
    criteria: [{ id: 'AC-1', text: 'Works in UI', proofs: ['e2e:smoke'] }],
    stage: 'review',
    revision: 3,
    createdAt: now(),
    updatedAt: now(),
    stageEnteredAt: now(),
    epoch: 1,
    candidate,
    submission: { epoch: 1, pr: 7 },
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: worker.id }],
    gates: [],
    implementers: [worker.id],
    observation: observationFixture(candidate, {
      source: 'control-plane',
      protected: false,
      files,
      scopeFiles: files.map(path => ({ path, status: 'modified' as const, sha: createHash('sha1').update(path).digest('hex'), additions: 1, deletions: 0, binary: false })),
    }),
  });
  reconcileAutoDispatch(work, [work], new Date());
  return work;
}

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }).catch(() => {}); });

async function masterFixture(label: string) {
  const host = await temporaryDirectory(`${label}-host`);
  const credentialDirectory = await temporaryDirectory(`${label}-creds`);
  directories.push(host, credentialDirectory);
  execFileSync('git', ['init', '-q', host]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: host });
  const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository, baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(host, { url, token: tokenOf(coordinator), cliPath: '/bin/true', credentialDirectory, herdrWorkspace: 'w1' }, status as typeof fetch);
  await saveReviewerProfile(host, { name: 'reviewer-1', agentName: 'review-claude-1', kind: 'claude', concurrency: 4 });
  return { host, config: await loadMasterConfig(host) };
}

test('integration:code-and-product-review-run-together — one head launches code and product review in the same tick with independent launch records and tokens; each verdict settles its own kind without withdrawing or overwriting the other', async () => {
  const { config } = await masterFixture('both-reviews');
  const work = await insert(featureItem('GY-7101'));
  assert.equal(work.autoDispatch?.review?.state, 'requested', 'code review is requested');
  assert.equal(work.autoDispatch?.product?.state, 'requested', 'product review is requested');

  const codeToken = freshToken(), productToken = freshToken();
  const launchedKinds: string[] = [];
  let codeLaunchId = '', productLaunchId = '', inFlight = 0, maxInFlight = 0;

  const tick = await runDispatchTick(config, emptyDispatchCursor(config), {
    snapshot: async () => ({ work: [work], now: now() }),
    agents: () => [],
    credentials: async () => ({}),
    reconcileReviews: async () => ({ reviews: [], released: [], notLive: [] }),
    reconcileProducers: async () => ({ producers: [] }),
    launchReview: async (item: Work) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        launchedKinds.push('code');
        const res = await post(tokenOf(coordinator), `work/${item.id}/review-launch`, launchBody(codeToken, { reviewer: 'review-code-1' }));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        codeLaunchId = res.body.launch;
        await new Promise(resolve => setTimeout(resolve, 40));
        return { agentName: 'review-code-1', pane: null };
      } finally { inFlight--; }
    },
    launchProductReview: async (item: Work) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        launchedKinds.push('product');
        const res = await post(tokenOf(coordinator), `work/${item.id}/review-launch`, launchBody(productToken, { reviewer: 'review-product-1', product: true }));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        productLaunchId = res.body.launch;
        await new Promise(resolve => setTimeout(resolve, 40));
        return { agentName: 'review-product-1', pane: null };
      } finally { inFlight--; }
    },
    launchProducer: async () => { throw new Error('no producer expected'); },
    persist: async () => {},
  } as never, Date.now);

  assert.equal(maxInFlight, 2, 'code and product review launches run concurrently in the same dispatch step');

  assert.deepEqual([...launchedKinds].sort(), ['code', 'product'], 'both code and product review launch in the same dispatch tick');
  assert.equal(tick.launched.length, 2, 'tick reports both launches');
  assert.notEqual(codeLaunchId, productLaunchId, 'each kind has its own launch record id');
  assert.equal(await tokenRegistered(http.services, hashOf(codeToken)), true, 'code review token is active');
  assert.equal(await tokenRegistered(http.services, hashOf(productToken)), true, 'product review token is active at the same time');

  // Both live reviewer sessions of the one item keep their registry slots: neither kind supersedes the other.
  const registry = emptyRegistry(), selected = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const reviewerSession = (id: string, group: string | null, minutes: number): FleetSession => ({ id, role: 'reviewer', account: id, runtime: 'claude', model: 'm', host: 'h', work: work.key, principal: null, group, selectedAt: selected(minutes), selectedBy: 'loop', reason: 'review', skipped: [], endedAt: null, endReason: null } as FleetSession);
  registry.sessions.push(reviewerSession('code', null, 5), reviewerSession('product', 'product', 4));
  assert.deepEqual(settleSessions(registry, [work], now()).map(entry => entry.id), [], 'a product review session never supersedes the code review session of its item');
  registry.sessions.push(reviewerSession('code-relaunch', null, 3));
  assert.deepEqual(settleSessions(registry, [work], now()).map(entry => entry.id), ['code'], 'a relaunch of the same kind still supersedes that kind only');

  // Code review verdict settles without withdrawing or overwriting the product review launch.
  const codeVerdict = await post(codeToken, `work/${work.id}/review-verdict`, {
    event: 'APPROVE',
    body: 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none',
    sha: H,
    token: codeToken,
  });
  assert.equal(codeVerdict.status, 200, JSON.stringify(codeVerdict.body));
  assert.equal(await tokenRegistered(http.services, hashOf(codeToken)), false, 'code token is spent after its verdict');
  assert.equal(await tokenRegistered(http.services, hashOf(productToken)), true, 'product token is NOT withdrawn by code verdict');

  // Product review verdict settles independently and leaves code review recorded.
  const productVerdict = await post(productToken, `work/${work.id}/review-verdict`, {
    event: 'APPROVE',
    body: 'Walked the UI; AC-1 works cleanly.',
    sha: H,
    token: productToken,
  });
  assert.equal(productVerdict.status, 200, JSON.stringify(productVerdict.body));
  assert.equal(await tokenRegistered(http.services, hashOf(productToken)), false, 'product token is spent after its verdict');

  const settled = await stored(work.id);
  assert.equal(settled.observation?.reviews.length, 1, 'code review verdict recorded on observation');
  assert.equal(settled.observation?.reviews[0]?.state, 'APPROVED');
  assert.equal(settled.observation?.reviews[0]?.sha, H);
  assert.equal(settled.observation?.reviews[0]?.baseSha, B);
  assert.equal(settled.observation?.reviews[0]?.policyRevision, 1);
  assert.equal(settled.productReview?.verdict, 'approved', 'product review verdict recorded on work.productReview');
  assert.equal(settled.productReview?.sha, H);
  assert.equal(settled.productReview?.baseSha, B);

  // Relaunch of one kind replaces only that kind's earlier launch and never withdraws the other kind's token.
  const code2 = freshToken(), product2 = freshToken(), code3 = freshToken();
  assert.equal((await post(tokenOf(coordinator), `work/${work.id}/review-launch`, launchBody(code2, { reviewer: 'review-code-2' }))).status, 200);
  assert.equal((await post(tokenOf(coordinator), `work/${work.id}/review-launch`, launchBody(product2, { reviewer: 'review-product-2', product: true }))).status, 200);
  assert.equal((await post(tokenOf(coordinator), `work/${work.id}/review-launch`, launchBody(code3, { reviewer: 'review-code-3' }))).status, 200);
  assert.equal(await tokenRegistered(http.services, hashOf(code2)), false, 'relaunch of code review replaces earlier code launch');
  assert.equal(await tokenRegistered(http.services, hashOf(code3)), true, 'new code launch token is active');
  assert.equal(await tokenRegistered(http.services, hashOf(product2)), true, 'code relaunch does not withdraw product launch token');
});

test('unit:product-reviews-share-only-a-fixed-port — two product reviews launch side by side on distinct ports when the serve command uses PORT, and take turns with a wait line when it binds a fixed port', async () => {
  const { host, config } = await masterFixture('product-ports');
  const stub = (body: string) => `import { createServer } from 'node:http';\n${body}\ncreateServer((_req, res) => res.end(String(port))).listen(port, '127.0.0.1');\n`;
  const env = () => ({ PATH: process.env.PATH ?? '' });

  // Case 1: serve command takes its port from PORT -> both launch side by side in the same tick on distinct ports.
  {
    const declaredPort = await freePort(), declared = `http://127.0.0.1:${declaredPort}/healthz`;
    const worktree = await temporaryDirectory('port-aware-wt');
    directories.push(worktree);
    await writeFile(join(worktree, 'serve.mjs'), stub(`const port = Number(process.env.PORT) || ${declaredPort};`));
    const serve = { command: 'node serve.mjs', url: declared, readySeconds: 30 };

    const itemA = featureItem('GY-7201'), itemB = featureItem('GY-7202');
    const served: { key: string; url: string; close: () => Promise<void> }[] = [];
    let inFlight = 0, maxInFlight = 0;
    try {
      const tick = await runDispatchTick(config, emptyDispatchCursor(config), {
        snapshot: async () => ({ work: [itemA, itemB], now: now() }),
        agents: () => [],
        credentials: async () => ({}),
        reconcileReviews: async () => ({ reviews: [], released: [], notLive: [] }),
        reconcileProducers: async () => ({ producers: [] }),
        launchReview: async () => ({ agentName: 'code-noop', pane: null }),
        launchProductReview: async (work: Work) => {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            const handle = await serveReviewHead({ root: host, id: `port-aware-${work.key}`, worktree, serve, env: env(), containment: 'setsid' });
            served.push({ key: work.key, url: handle.url, close: handle.close });
            await new Promise(resolve => setTimeout(resolve, 40));
            return { agentName: `product-${work.key}`, pane: null };
          } finally { inFlight--; }
        },
        launchProducer: async () => { throw new Error('no producer'); },
        persist: async () => {},
      } as never, Date.now);

      assert.equal(maxInFlight, 2, 'two PORT-aware product reviews launch side by side');

      const productLaunched = tick.launched.filter(entry => entry.reason === 'product review');
      assert.equal(productLaunched.length, 2, 'both product reviews launched in the same tick');
      assert.equal(served.length, 2);
      assert.notEqual(served[0]!.url, served[1]!.url, 'each product review serves on its own distinct port');
      assert.notEqual(new URL(served[0]!.url).port, String(declaredPort));
      assert.notEqual(new URL(served[1]!.url).port, String(declaredPort));
    } finally {
      await Promise.all(served.map(entry => entry.close()));
    }
  }

  // Case 2: serve command binds a fixed declared port -> they take turns, with the wait line naming the served address.
  {
    const declaredPort = await freePort(), declared = `http://127.0.0.1:${declaredPort}/healthz`;
    const worktree = await temporaryDirectory('fixed-port-wt');
    directories.push(worktree);
    await writeFile(join(worktree, 'serve.mjs'), stub(`const port = ${declaredPort};`));
    const serve = { command: 'node serve.mjs', url: declared, readySeconds: 30 };

    const itemA = featureItem('GY-7203'), itemB = featureItem('GY-7204');
    const served: { key: string; url: string; close: () => Promise<void> }[] = [];
    try {
      const effects = {
        snapshot: async () => ({ work: [itemA, itemB], now: now() }),
        agents: () => [],
        credentials: async () => ({}),
        reconcileReviews: async () => ({ reviews: [], released: [], notLive: [] }),
        reconcileProducers: async () => ({ producers: [] }),
        launchReview: async () => ({ agentName: 'code-noop', pane: null }),
        launchProductReview: async (work: Work) => {
          const handle = await serveReviewHead({ root: host, id: `fixed-port-${work.key}`, worktree, serve, env: env(), containment: 'setsid', refuseTurn: true });
          served.push({ key: work.key, url: handle.url, close: handle.close });
          return { agentName: `product-${work.key}`, pane: null };
        },
        launchProducer: async () => { throw new Error('no producer'); },
        persist: async () => {},
      };

      // Both owed in one dispatch step: one serves the fixed port, the other takes its turn at once with the wait line, unrefused.
      const started = Date.now();
      const firstTick = await runDispatchTick(config, emptyDispatchCursor(config), effects as never, Date.now);
      assert.ok(Date.now() - started < 60_000, 'the waiting review does not sit out its launch bound');
      assert.equal(firstTick.launched.filter(entry => entry.reason === 'product review').length, 1, 'one product review launches on the fixed declared port');
      assert.equal(served.length, 1);
      assert.equal(served[0]!.url, new URL(declared).origin);
      const waiting = served[0]!.key === itemA.key ? itemB : itemA;
      assert.equal(firstTick.refused.length, 0, 'the waiting product review is not refused');
      assert.ok(firstTick.waiting.some(entry => entry.work === waiting.key && entry.reason.includes('takes its turn') && entry.reason.includes(declared)), `wait line names the fixed address: ${JSON.stringify(firstTick.waiting)}`);

      // A later step while it still serves: the other still waits its turn.
      const secondTick = await runDispatchTick(config, emptyDispatchCursor(config), { ...effects, snapshot: async () => ({ work: [waiting], now: now() }) } as never, Date.now);
      assert.equal(secondTick.launched.filter(entry => entry.reason === 'product review').length, 0);
      assert.equal(secondTick.refused.length, 0, 'the waiting product review is not refused');
      assert.ok(secondTick.waiting.some(entry => entry.work === waiting.key && entry.reason.includes('takes its turn') && entry.reason.includes(declared)), `wait line names the fixed address: ${JSON.stringify(secondTick.waiting)}`);

      // Once the first review closes its serve, the second launches on the next tick.
      await served[0]!.close();
      const thirdTick = await runDispatchTick(config, emptyDispatchCursor(config), { ...effects, snapshot: async () => ({ work: [waiting], now: now() }) } as never, Date.now);
      assert.equal(thirdTick.launched.filter(entry => entry.reason === 'product review').length, 1, 'second product review launches once the fixed port frees');
    } finally {
      await Promise.all(served.map(entry => entry.close()));
    }
  }
});

test('unit:stored-single-review-launch-still-settles — an item stored with the legacy single-slot reviewLaunch settles without a relaunch, even if a product review launches beside it, and tick.ts has no productTurn or wait-for-the-other-reviewer branch', async () => {
  const tickSource = await readFile(new URL('../src/dispatch/tick.ts', import.meta.url), 'utf8');
  assert.equal(/productTurn/.test(tickSource), false, 'productTurn chain is deleted from src/dispatch/tick.ts');
  assert.equal(/waits for the reviewer session already judging/.test(tickSource), false, 'wait-for-the-other-reviewer branch is deleted from src/dispatch/tick.ts');

  const work = featureItem('GY-7301');
  const legacyToken = freshToken();
  const legacyLaunchId = randomUUID();
  // Store a legacy single-slot reviewLaunch record (no reviewLaunches map), as persisted before this deploy.
  work.reviewLaunch = {
    id: legacyLaunchId,
    reviewer: 'review-legacy-1',
    requester: coordinator.id,
    head: H,
    baseTip: B,
    policyRevision: 1,
    tokenHash: hashOf(legacyToken),
    at: now(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    postMerge: false,
    verdict: null,
  };
  await insert(work);

  assert.equal(await tokenRegistered(http.services, hashOf(legacyToken)), true, 'legacy single-slot launch token still authenticates');

  // Even if a product review launches on the same item before the legacy code review finishes, the legacy launch survives.
  const productToken = freshToken();
  assert.equal((await post(tokenOf(coordinator), `work/${work.id}/review-launch`, launchBody(productToken, { reviewer: 'review-product-1', product: true }))).status, 200);
  assert.equal(await tokenRegistered(http.services, hashOf(legacyToken)), true, 'legacy code launch token is preserved when product review launches');

  // The legacy code review posts its verdict and settles without a relaunch.
  const res = await post(legacyToken, `work/${work.id}/review-verdict`, {
    event: 'APPROVE',
    body: 'AC-1 met.\nResolved threads: none\nFollow-up threads: none\nOverridden threads: none',
    sha: H,
    token: legacyToken,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await tokenRegistered(http.services, hashOf(legacyToken)), false, 'legacy token is withdrawn after settling');
  const afterSettle = await stored(work.id);
  const read = controlPlaneVerdict({ key: work.key, sha: H, launch: legacyLaunchId }, [afterSettle]);
  assert.equal(read?.state, 'APPROVED', 'controlPlaneVerdict reads the settled verdict of the legacy launch');
  assert.equal(afterSettle.observation?.reviews.length, 1);
  assert.equal(afterSettle.observation?.reviews[0]?.reviewer, 'review-legacy-1');
  assert.equal(await tokenRegistered(http.services, hashOf(productToken)), true, 'product review token remains active');
});
