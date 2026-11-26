import { after, before } from 'node:test';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { loadMasterConfig, setupMaster, type MasterConfig } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { chooseSession, proposedRuntimes, unobservedQuota, type AgentRegistry as RegistryDoc } from '../src/model/registry.js';
import { launchReview, readReviewLedger, reviewCommand, saveReviewerProfile } from '../src/reviewer.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { dispatchEffects } from '../src/dispatch/effects.js';
import { renewReviewRequest } from '../src/server/review-verdict.js';
import { pendingHeadless } from './helpers/pending-review.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { endRun } from '../src/runner/registry.js';
import { listen } from './helpers/http-server.js';
import { workFixture } from './helpers/work-fixture.js';
import { observationFixture } from './helpers/observation-fixture.js';
const dropRun = (name: string) => endRun(name, { ok: false, reason: 'exit', detail: 'dropped', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() } as any);

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
let store: Store, engine: Engine, close: (() => Promise<void>) | undefined, registry: AgentRegistry, url: string;
let root: string, scratch: string, base: string, head: string, hostId: string;

before(async () => {
  store = await withDatabase('review-launch-skips-spent'); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));
  root = await temporaryDirectory('review-skips-spent-root');
  scratch = await temporaryDirectory('review-skips-spent-scratch');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Spec.\n');
  git('add', 'README.md'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'feature.ts'), 'export const ok = true;\n');
  git('add', 'feature.ts'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'head');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: join(scratch, 'credentials'), herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('review-skips-spent-checkouts', join(process.cwd(), '.graphyard')) } });
  hostId = (await loadMasterConfig(root)).hostId;
  registry = new AgentRegistry(store);
});

after(async () => { await close?.(); if (store) await store.close(); for (const dir of [root, scratch]) if (dir) await rm(dir, { recursive: true, force: true }); });

const gitRun = (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`unexpected command ${command}`);
};

const insertWork = async (work: Work) => {
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
};

function makeReviewItem(key: string, requestId: string, at: string, extra: Partial<Work> = {}): Work {
  const candidate = { sha: head, baseSha: base, pr: 11, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-worker-1' };
  return workFixture({
    id: randomUUID(), key, title: `Item ${key}`, type: 'bug', risk: 'sensitive', riskSource: 'operator', priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    stage: 'review', revision: 3, createdAt: at, updatedAt: at, stageEnteredAt: at, epoch: 1, workspaces: [{ host: hostId, path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-worker-1' }],
    candidate, submission: { epoch: 1, pr: 11 }, gates: [], implementers: ['graphyard-worker-1'],
    autoDispatch: {
      review: { id: requestId, kind: 'review', provider: 'github', pr: 11, sha: head, baseSha: base, policyRevision: 1, state: 'requested', requestedAt: at, reason: 'review required' },
      producers: [], history: [],
    },
    observation: observationFixture(candidate, { source: 'control-plane', at, protected: false,
      files: ['src/server/auth.ts'], scopeFiles: [{ path: 'src/server/auth.ts', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }] }),
    ...extra,
  });
}

test('unit:review-launch-skips-spent-accounts — first reviewer exhausted, broken, logged-out or builder is skipped and second is chosen regardless of master.json profiles', async () => {
  const now = Date.now();
  const future = new Date(now + 3_600_000).toISOString();
  const baseDoc = (accounts: RegistryDoc['accounts']): RegistryDoc => ({
    version: 1, revision: 1, updatedAt: new Date(now).toISOString(),
    runtimes: proposedRuntimes.filter(r => r.name === 'claude'),
    models: [{ name: 'opus', id: 'opus', provider: 'anthropic', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    accounts,
    roles: [{ name: 'reviewer', accounts: accounts.map(a => a.name), concurrency: 4 }],
    sessions: [], refusals: [], lastMutation: null,
  });

  // 1. First reviewer exhausted, second chosen.
  const exhaustedDoc = baseDoc([
    { name: 'claude-a', runtime: 'claude', model: 'opus', enabled: true, maxSessions: null, credential: { host: hostId, home: null }, quota: { ...unobservedQuota, state: 'exhausted', loggedIn: true, source: 'operator', resetsAt: future, reason: 'weekly limit' }, smoke: null },
    { name: 'claude-b', runtime: 'claude', model: 'opus', enabled: true, maxSessions: null, credential: { host: hostId, home: null }, quota: { ...unobservedQuota, state: 'available', loggedIn: true }, smoke: null },
  ]);
  const c1 = chooseSession(exhaustedDoc, { role: 'reviewer', host: hostId, work: 'GY-101' }, now);
  assert.equal(c1.account?.name, 'claude-b', 'exhausted first reviewer is skipped for the second');

  // 2. Broken and not-logged-in reviewers are skipped.
  const brokenDoc = baseDoc([
    { name: 'claude-a', runtime: 'claude', model: 'opus', enabled: true, maxSessions: null, credential: { host: hostId, home: null }, quota: { ...unobservedQuota, state: 'broken', loggedIn: true, reason: 'auth failed' }, smoke: null },
    { name: 'claude-b', runtime: 'claude', model: 'opus', enabled: true, maxSessions: null, credential: { host: hostId, home: null }, quota: { ...unobservedQuota, state: 'unknown', loggedIn: false, reason: 'not logged in' }, smoke: null },
    { name: 'claude-c', runtime: 'claude', model: 'opus', enabled: true, maxSessions: null, credential: { host: hostId, home: null }, quota: { ...unobservedQuota, state: 'available', loggedIn: true }, smoke: null },
  ]);
  const c2 = chooseSession(brokenDoc, { role: 'reviewer', host: hostId, work: 'GY-102' }, now);
  assert.equal(c2.account?.name, 'claude-c', 'broken and logged-out accounts are skipped');

  // 3. Account that built the item is skipped even when on the same provider.
  const builderDoc = baseDoc([
    { name: 'claude-a', runtime: 'claude', model: 'opus', enabled: true, maxSessions: null, credential: { host: hostId, home: null }, quota: { ...unobservedQuota, state: 'available', loggedIn: true }, smoke: null },
    { name: 'claude-b', runtime: 'claude', model: 'opus', enabled: true, maxSessions: null, credential: { host: hostId, home: null }, quota: { ...unobservedQuota, state: 'available', loggedIn: true }, smoke: null },
  ]);
  const c3 = chooseSession(builderDoc, { role: 'reviewer', host: hostId, work: 'GY-103' }, now, { work: 'GY-103', provider: 'anthropic', account: 'claude-a' });
  assert.equal(c3.account?.name, 'claude-b', 'account that built the item is skipped');

  // 4. Launch with no reviewer profile in master.json still picks the first eligible reviewer from the registry.
  const at = new Date(now).toISOString();
  await registry.mutate(coordinator, 'apply', {
    runtimes: proposedRuntimes.filter(r => r.name === 'claude'),
    models: [{ name: 'opus', id: 'opus', provider: 'anthropic', cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    accounts: [
      { name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } },
      { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } },
    ],
    roles: [{ name: 'reviewer', accounts: ['claude-a', 'claude-b'], concurrency: 4 }],
    reason: 'two reviewer accounts',
  }, randomUUID());
  await registry.mutate(coordinator, 'account.quota', {
    name: 'claude-a', quota: { state: 'exhausted', resetsAt: future }, reason: 'spent until later',
  }, randomUUID());
  const item = await insertWork(makeReviewItem('GY-9501', 'req-9501', at));
  const launched = await launchReview(root, item, undefined, [], at, {
    run: gitRun,
    requestId: 'req-9501',
    headless: (command, args, options) => pendingHeadless(command, args, options),
  });
  assert.equal(launched.account?.environment, 'claude-b', 'launch with no master.json reviewer profile picks claude-b over exhausted claude-a');
});

test('unit:review-launch-skips-spent-accounts — session never goes live after 2 minutes is released, relaunched on the next eligible account, and recorded in item history', async () => {
  let clock = Date.now();
  const at = () => new Date(clock).toISOString();
  await saveReviewerProfile(root, { name: 'review-claude-a', agentName: 'review-claude-a', kind: 'claude' });
  const config = await loadMasterConfig(root) as MasterConfig;
  const fixture = registryFixture(config.hostId!, ['claude', 'codex'], ['reviewer'], 4);
  const item = await insertWork(makeReviewItem('GY-9502', 'req-9502', at()));
  const chosenAccounts: string[] = [];
  const mutate = async (path: string, body: unknown) => {
    const res = await fetch(`${url}/api/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${coordinatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body),
    });
    const parsed = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(parsed));
    return parsed;
  };
  const loadItem = async () => (await store.pool.query('SELECT document FROM work_items WHERE id = $1', [item.id])).rows[0].document as Work;
  const baseEffects = dispatchEffects(root, () => config, {
    snapshot: async () => ({ work: [await loadItem()], now: at() }),
    mutate,
    run: gitRun,
    now: () => clock,
  });
  const effects = {
    ...baseEffects,
    inventory: async () => ({ available: true, agents: [], panes: [], sessions: [] }),
    agents: async () => [],
    registry: () => fixture.client.document(),
    endRegistrySession: (session: { id: string }, reason: string) => fixture.client.end(session.id, reason),
    launchReview: async (work: Work, request: any, profile: any, agents: any, observedAt: string) => {
      const res = await launchReview(root, work, profile.name, agents, observedAt, {
        run: gitRun,
        now: () => new Date(clock),
        requestId: request.id,
        probe: fixture.probe,
        headless: (command, args, options) => pendingHeadless(command, args, options),
      });
      if (res.account?.environment) chosenAccounts.push(res.account.environment);
      // Simulate the session never going live (not in inventory, not in liveRun).
      dropRun(res.agentName);
      return res;
    },
  };

  const cursor = emptyDispatchCursor(config);
  const first = await runDispatchTick(config, cursor, effects, () => clock);
  assert.equal(first.launched.length, 1);
  assert.equal(chosenAccounts.length, 1);
  const firstAccount = chosenAccounts[0]!;

  // Advance 2 minutes: session is still not live in inventory or liveRun.
  clock += 2 * 60_000 + 1_000;
  const second = await runDispatchTick(config, cursor, effects, () => clock);
  assert.equal(second.launched.length, 1, `review is relaunched after 2 minutes not live: ${JSON.stringify({ second, ledger: (await readReviewLedger(root)).reviews.filter(r => r.key === 'GY-9502') })}`);
  assert.equal(chosenAccounts.length, 2);
  assert.notEqual(chosenAccounts[1], firstAccount, 'relaunch moves to the next eligible account');

  // Recorded in the item's history (events table).
  const events = (await store.pool.query('SELECT kind, payload FROM events WHERE work_id = $1 ORDER BY seq ASC', [item.id])).rows;
  assert.ok(events.some(e => JSON.stringify(e.payload).includes('not live')), 'release of non-live review session is recorded in item history');
});

test('unit:review-launch-skips-spent-accounts — manual relaunch over a dead session succeeds, over a live one is refused', async () => {
  const now = new Date();
  const at = now.toISOString();
  const services = { engine } as any;

  // 1. API path (renewReviewRequest): dead session (missedReports >= 2, not live) is replaced and succeeds.
  const deadItem = await insertWork(makeReviewItem('GY-9503', 'req-9503', at, {
    sessions: [{
      id: 'req-9503', kind: 'review', role: 'review', head, runtime: 'claude', host: hostId,
      subject: 'GY-9503: review', state: 'running', startedAt: new Date(now.getTime() - 180_000).toISOString(),
      updatedAt: new Date(now.getTime() - 180_000).toISOString(), observed: null, observedAt: new Date(now.getTime() - 180_000).toISOString(),
      missedReports: 2,
    }] as any,
  }));
  const renewed = await renewReviewRequest(services, coordinator, deadItem.id, randomUUID());
  assert.equal(renewed.renewed, true, 'manual relaunch over a dead session succeeds');
  assert.ok(renewed.requestId && renewed.requestId !== 'req-9503', 'a fresh review request is opened');
  const afterDead = (await store.pool.query('SELECT document FROM work_items WHERE id = $1', [deadItem.id])).rows[0].document as Work;
  assert.equal(afterDead.sessions?.find(s => s.id === 'req-9503')?.state, 'finished', 'dead reviewer session is closed');

  // 2. API path (renewReviewRequest): live session is refused.
  const liveItem = await insertWork(makeReviewItem('GY-9504', 'req-9504', at, {
    sessions: [{
      id: 'req-9504', kind: 'review', role: 'review', head, runtime: 'claude', host: hostId,
      subject: 'GY-9504: review', state: 'running', startedAt: at, updatedAt: at,
      observed: 'working', observedAt: at, missedReports: 0,
    }] as any,
  }));
  await assert.rejects(
    () => renewReviewRequest(services, coordinator, liveItem.id, randomUUID()),
    /is running on .* it answers the request/,
    'manual relaunch over a live session is refused',
  );

  // 3. Direct host command path (`master review GY-N PROFILE` via reviewCommand):
  //    over a dead pending ledger session succeeds; over a live one is refused.
  await saveReviewerProfile(root, { name: 'review-opencode-a', agentName: 'review-opencode-a', kind: 'opencode' });
  const fixture = registryFixture(hostId, ['claude', 'opencode'], ['reviewer'], 4);
  const directItem = await insertWork(makeReviewItem('GY-9505', 'req-9505', at));
  const firstLaunch = await launchReview(root, directItem, 'review-claude-a', [], at, {
    run: gitRun,
    requestId: 'req-9505',
    probe: fixture.probe,
    headless: (command, args, options) => pendingHeadless(command, args, options),
  });
  dropRun(firstLaunch.agentName);
  // Over a live session (reported in agents): refused.
  await assert.rejects(
    () => reviewCommand(root, ['GY-9505', 'review-opencode-a'], { work: [directItem], now: at }, [{ name: firstLaunch.agentName }], {
      run: gitRun, probe: fixture.probe, headless: (command, args, options) => pendingHeadless(command, args, options),
    }),
    /already pending|already visible/,
    'direct manual relaunch over a live session is refused',
  );
  // Over a dead session (not in agents and not in liveRun): succeeds.
  const replaced = await reviewCommand(root, ['GY-9505', 'review-opencode-a'], { work: [directItem], now: at }, [], {
    run: gitRun, probe: fixture.probe, headless: (command, args, options) => pendingHeadless(command, args, options),
  });
  assert.ok(replaced.review && replaced.review !== firstLaunch.review, 'direct manual relaunch over a dead session replaces it');
  const records = (await readReviewLedger(root)).reviews.filter(r => r.key === 'GY-9505');
  assert.equal(records.find(r => r.id === firstLaunch.review)?.state, 'failed', 'replaced dead record is settled as failed');
});
