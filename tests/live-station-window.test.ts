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

// GY-3732: the live station counts only merges made inside each window, timed from merge to the first
// deploy that served a commit containing it, so a week-old merge never inflates the 6h or 24h numbers.
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
  ({ root: repoRoot } = await gitRepo({ label: 'live-station-window-repo' }));
  await commitFile(repoRoot, 'base.txt', 'base\n');
  process.env.GRAPHYARD_REPOSITORY_ROOT = repoRoot;
  store = await withDatabase('live-station-window'); await store.init();
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
  const directory = await temporaryDirectory('live-station-window-cfg');
  const config = masterConfigSchema.parse({ version: 1, url, repository, credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  return masterStatusReport(repoRoot, config, masterApi, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${git(repoRoot, 'rev-parse', 'HEAD')}\n`);
}

function fakePorts(tip: string, head: string): DeployWatchPorts {
  return {
    fetch: async () => tip,
    head: async () => head,
    checkout: async () => {},
    build: async () => {},
    restart: async () => {},
    health: async () => {},
    pin: async () => {},
    prune: async () => {},
    schema: async () => 1,
    database: async () => 1,
  };
}

test('integration:live-station-window — each window counts only its own merges, timed to their first serving deploy', async () => {
  const base = git(repoRoot, 'rev-parse', 'HEAD');
  const old = await commitFile(repoRoot, 'old.txt', 'old\n');
  const recent = await commitFile(repoRoot, 'recent.txt', 'recent\n');
  // A merge 5 days ago first served by the deploy 40 min ago (7160 min); the base deploy before it did not carry it.
  await seedMerged('Week-old merge', old, 5 * 1440);
  // A merge 60 min ago that went live 40 min ago (20 min).
  const fresh = await seedMerged('Fresh merge', recent, 60);
  const stateDir = join(repoRoot, '.graphyard');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'deploy-history.jsonl'), [
    JSON.stringify({ commit: base, at: ago(6 * 1440), repository }),
    JSON.stringify({ commit: recent, at: ago(40), repository }),
  ].join('\n') + '\n');

  forgetFlow(store);
  const flow = await call(adminToken, 'flow');
  for (const window of ['6h', '24h']) {
    const live = flow[window].stations.live;
    assert.equal(live.samples, 1, `${window} counts only the merge made inside it`);
    assert.ok(Math.abs(live.median - 20) <= 1, `${window} median ~20 min, got ${live.median}`);
    assert.equal(live.oldest.key, fresh.key);
    assert.equal(live.oldest.waiting, false, 'a merge already serving is never oldest waiting');
  }
  const week = flow['7d'].stations.live;
  assert.equal(week.samples, 2, '7d counts both merges');
  assert.ok(week.p90 > 6000, `7d p90 carries the old merge's ~7160 min, got ${week.p90}`);
  assert.equal(week.oldest.waiting, false);
  assert.ok(!flow.attention || flow.attention.subject !== 'live', `no live alert from older merges: ${flow.attention?.text}`);
});

test('e2e:live-station-window — after a merge deploys, master status shows a 6h live station within the window and no slow-live alert', async () => {
  const previous = git(repoRoot, 'rev-parse', 'HEAD');
  const next = await commitFile(repoRoot, 'next.txt', 'next\n');
  await seedMerged('Deployed merge', next, 5);
  assert.equal(await deployOnce(deployRecordPath(repoRoot), fakePorts(next, previous), () => {}, repository), 'deployed');

  forgetFlow(store);
  const status = await report();
  assert.ok(status.flow, `flow is shown (${status.flowError})`);
  const live = status.flow['6h'].stations.live;
  assert.ok(live, 'master status 6h flow carries a live station');
  assert.equal(live.samples, 2, 'only the two merges inside 6 hours');
  assert.ok(live.p90 <= 60, `6h samples stay within the window, p90 ${live.p90}`);
  assert.equal(live.oldest.waiting, false);
  assert.ok(!status.attention.some((line: { text: string }) => line.text.startsWith('Live is slow')), 'no Live is slow alert for older merges');
});
