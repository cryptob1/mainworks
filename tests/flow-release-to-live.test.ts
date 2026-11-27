import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { forgetFlow } from '../src/server/flow.js';
import { server } from '../src/server.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { deployOnce, deployRecordPath, type DeployWatchPorts } from '../src/deploy-watch.js';
import type { Principal } from '../src/model.js';
import { listen } from './helpers/http-server.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
// The repositories these tests seed carry an e2e proof, so the policy in force says how a head is served
// for them; it is read once per process, and nothing reads it ahead of this line.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3725: flow numbers measure merge-to-live time (median, p90, samples and oldest merged change
// not yet serving) as the 'live' station, joining each merge with the first serving deploy record
// whose commit contains it.
const admin: Principal = { id: 'operator', role: 'admin' };
const adminToken = `operator-${'t'.repeat(32)}`;
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const repository = 'owner/game';
let store: Store, close: (() => Promise<void>) | undefined, url: string, repoRoot: string;
const previousRoot = process.env.GRAPHYARD_REPOSITORY_ROOT;

const commitFile = async (cwd: string, name: string, content: string) => {
  await writeFile(join(cwd, name), content);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', `add ${name}`);
  return git(cwd, 'rev-parse', 'HEAD');
};

before(async () => {
  ({ root: repoRoot } = await gitRepo({ label: 'flow-release-to-live-repo', files: { 'base.txt': 'base\n' }, message: 'add base.txt' }));
  process.env.GRAPHYARD_REPOSITORY_ROOT = repoRoot;
  store = await withDatabase('flow-release-to-live'); await store.init();
  ({ url, close } = await listen(server(new Engine(store, 120, repository), [{ ...admin, token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }])));
});

after(async () => {
  await close?.();
  if (store) await store.close();
  if (previousRoot === undefined) delete process.env.GRAPHYARD_REPOSITORY_ROOT;
  else process.env.GRAPHYARD_REPOSITORY_ROOT = previousRoot;
});

const call = async (token: string, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, {
    method: body ? 'POST' : 'GET',
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${path}-${Math.random()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(text), { status: response.status });
  return JSON.parse(text);
};
const masterApi = (path: string) => call(coordinatorToken, path);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function seedMerged(title: string, mergeSha: string, mergedMinutesAgo: number) {
  const item = await call(adminToken, 'work', { title, why: 'Live station is measured.', simplest: 'One line.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] });
  await call(adminToken, `work/${item.id}/ready`, { reason: 'Seeded' });
  await store.pool.query('UPDATE work_items SET document = document || $2::jsonb WHERE id=$1', [item.id, JSON.stringify({
    stage: 'done', stageEnteredAt: ago(mergedMinutesAgo),
    delivery: { mergedAt: ago(mergedMinutesAgo), mergeSha, authorizationRevision: 1 },
    nextAction: null, queue: null, lease: null, actionQueue: { actions: [] }, sessions: [],
    pipeline: { attempts: [{ epoch: 1, owner: 'worker', claimedAt: ago(mergedMinutesAgo + 30), endedAt: ago(mergedMinutesAgo + 10), end: 'submitted' }], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
  })]);
  return item;
}

async function report() {
  const directory = await temporaryDirectory('flow-release-to-live-cfg');
  const config = masterConfigSchema.parse({ version: 1, url, repository, credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  return masterStatusReport(repoRoot, config, masterApi, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${git(repoRoot, 'rev-parse', 'HEAD')}\n`);
}

function fakePorts(tip: string, head: string, failBuild = false): DeployWatchPorts {
  return {
    fetch: async () => tip,
    head: async () => head,
    checkout: async () => {},
    build: async () => { if (failBuild) throw new Error('build broke'); },
    restart: async () => {},
    health: async () => {},
    pin: async () => {},
    prune: async () => {},
    schema: async () => 1,
    database: async () => 1,
  };
}

test('integration:flow-release-to-live — live station reports median, p90, samples and oldest unserved merge from first containing deploy', async () => {
  const base = git(repoRoot, 'rev-parse', 'HEAD');
  const m1 = await commitFile(repoRoot, 'm1.txt', 'one\n');
  const m2 = await commitFile(repoRoot, 'm2.txt', 'two\n');
  const m3 = await commitFile(repoRoot, 'm3.txt', 'three\n');

  // M1 merged 60m ago, deployed 40m ago -> 20 min.
  // M2 merged 35m ago, deployed 25m ago -> 10 min (M1 stays at 20 min, its FIRST serving deploy).
  // M3 merged 15m ago, deploy of M3 failed and rolled back to M2 -> still waiting 15 min.
  await seedMerged('First merge', m1, 60);
  await seedMerged('Second merge', m2, 35);
  const third = await seedMerged('Third merge', m3, 15);

  const stateDir = join(repoRoot, '.graphyard');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'deploy-history.jsonl'), [
    JSON.stringify({ commit: base, at: ago(120), repository }),
    JSON.stringify({ commit: m1, at: ago(40), repository }),
    JSON.stringify({ commit: m2, at: ago(25), repository }),
  ].join('\n') + '\n');
  await writeFile(deployRecordPath(repoRoot), JSON.stringify({ tip: m2, failed: m3, reason: 'build failed', at: ago(10), repository }));

  forgetFlow(store);
  const flow = await call(adminToken, 'flow');
  const live = flow['24h'].stations.live;
  assert.ok(live, '24h flow carries a live station');
  assert.equal(live.samples, 3);
  assert.ok(Math.abs(live.median - 15) <= 1, `expected median ~15 min, got ${live.median}`);
  assert.ok(Math.abs(live.p90 - 20) <= 1, `expected p90 ~20 min, got ${live.p90}`);
  assert.equal(live.oldest.key, third.key, 'oldest names the merged change not yet serving');
  assert.equal(live.oldest.waiting, true);
  assert.ok(Math.abs(live.oldest.minutes - 15) <= 1, `expected oldest ~15 min, got ${live.oldest.minutes}`);

  // A failed deploy of M3 via deployOnce rolls back to M2 and does not mark M3 as live.
  assert.equal(await deployOnce(deployRecordPath(repoRoot), fakePorts(m3, m2, true), () => {}, repository), 'rolled-back');
  forgetFlow(store);
  const afterRollback = (await call(adminToken, 'flow'))['24h'].stations.live;
  assert.equal(afterRollback.oldest.key, third.key);
  assert.equal(afterRollback.oldest.waiting, true);
});

test('e2e:flow-release-to-live — after a merge deploys, master status shows a live station with at least one sample', async () => {
  const previous = git(repoRoot, 'rev-parse', 'HEAD');
  const m4 = await commitFile(repoRoot, 'm4.txt', 'four\n');
  await seedMerged('Deployed merge', m4, 5);

  // Deploy m4 through the real deployOnce watch pass.
  assert.equal(await deployOnce(deployRecordPath(repoRoot), fakePorts(m4, previous), () => {}, repository), 'deployed');

  forgetFlow(store);
  const status = await report();
  assert.ok(status.flow, `flow is shown (${status.flowError})`);
  const live = status.flow['24h'].stations.live;
  assert.ok(live, 'master status 24h flow carries a live station');
  assert.ok(live.samples >= 1, `expected at least 1 sample, got ${live.samples}`);
  assert.equal(typeof live.median, 'number');
  assert.equal(typeof live.p90, 'number');
  assert.equal(live.oldest.waiting, false, 'all merged changes are now serving');
});
