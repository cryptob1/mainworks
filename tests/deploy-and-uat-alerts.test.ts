import { listen } from './helpers/http-server.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Launcher, type Cycle } from '../src/daemon/cycle.js';
import { readDaemonState, writeDaemonState, type DaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { deliveryAlertStep, postAlert } from '../src/daemon/delivery-alerts.js';
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3529: beside the stalled-yard alert, the loop tells run.alertUrl which items the delivery watch
// newly serves and which release candidate failed UAT, each once and never again after a restart;
// a Slack incoming webhook gets {"text": ...}, any other receiver the plain-text body.

const commit = (root: string, message: string) => { git(root, 'commit', '--allow-empty', '-q', '-m', message); return git(root, 'rev-parse', 'HEAD'); };

const done = (key: string, title: string, mergeSha: string) => ({ id: key, key, title, stage: 'done', delivery: { mergedAt: '2030-04-01T00:00:00Z', mergeSha, authorizationRevision: 1 } }) as unknown as Work;

async function world(alertUrl: string) {
  const { root } = await gitRepo({ label: 'deploy-alerts-repo' });
  const home = await temporaryDirectory('deploy-alerts-home');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(home, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { alertUrl } }) as MasterConfig;
  return { root, config };
}

/** One loop cycle's alert step over the served commit the delivery watch records, as a loop just restarted onto its cursor would run it. */
async function step(root: string, config: MasterConfig, served: string, work: Work[], webhook: (text: string) => Promise<void>, watch: 'serve' | 'deploy' = 'serve') {
  const state: DaemonState = await readDaemonState(root, config);
  // `serve` records the commit in served.json (a declared node app); `deploy` only in the deploy watch's deploy.json.
  const effects = { alertWebhook: webhook, persist: (next: DaemonState) => writeDaemonState(config, next), servingCommit: () => watch === 'deploy' ? served : null,
    mergeWriter: { serveRecord: async () => watch === 'serve' ? { commit: served, check: null } : null, git: async (args: string[]) => git(root, ...args), gate: { root, repository: config.repository } } } as unknown as DaemonEffects;
  const cycle = { config, state, effects, now: () => Date.now(), snapshot: { work, now: new Date().toISOString() }, clock: Date.now(), herdr: { agents: [], available: true },
    credentials: {}, performed: [], launcher: new Launcher(1), reservedProfiles: new Set(), log: () => {} } as unknown as Cycle;
  await deliveryAlertStep(cycle);
  return state;
}

const failedGate = (root: string, served: string, candidate: string) => writeGateRecord(gateRecordPath(root), { ...bootstrapGate('owner/project', served),
  lastOutcome: { tip: candidate, outcome: 'reverted', reason: 'e2e:login failed', finishedAt: new Date().toISOString(), cases: { 'e2e:login': 'fail', 'e2e:board': 'pass', 'e2e:checkout': 'fail' } } });

test('integration:deploy-and-uat-alerts — newly served items are announced once with key, title and commit; a failed candidate once with its SHA, the served SHA and its failed cases; neither repeats after a restart', async () => {
  const posts: string[] = [];
  const { root, config } = await world('https://ntfy.example/yard');
  const webhook = async (text: string) => { posts.push(text); };
  const first = commit(root, 'base');
  // The first served commit a cursor sees is remembered, not announced: it has nothing new to say.
  await step(root, config, first, [], webhook);
  assert.deepEqual(posts, []);

  const a = commit(root, 'GY-1'), b = commit(root, 'GY-2');
  const work = [done('GY-0', 'Old', first), done('GY-1', 'Login page', a), done('GY-2', 'Board filters', b)];
  const state = await step(root, config, b, work, webhook);
  assert.equal(posts.length, 1, 'one deployed message');
  assert.equal(posts[0], `Mainworks owner/project: deployed ${b.slice(0, 12)}\nGY-1 Login page (${a.slice(0, 12)})\nGY-2 Board filters (${b.slice(0, 12)})`);
  assert.equal(state.deliveryAlerts.served, b, 'the announced commit is on the cursor');
  // A restarted loop reads the cursor and says nothing again.
  await step(root, config, b, work, webhook);
  assert.equal(posts.length, 1, 'not repeated after a restart');

  const candidate = commit(root, 'GY-3');
  await failedGate(root, b, candidate);
  await step(root, config, b, work, webhook);
  assert.equal(posts.length, 2, 'one UAT-failed message');
  assert.equal(posts[1], `Mainworks owner/project: UAT failed on candidate ${candidate.slice(0, 12)}; ${b.slice(0, 12)} stays served. Failed: e2e:login, e2e:checkout`);
  assert.doesNotMatch(posts.at(-1)!, /\n/, 'one short line');
  await step(root, config, b, work, webhook);
  assert.equal(posts.length, 2, 'not repeated for the same candidate, across a restart');
});

test('integration:deploy-and-uat-alerts — without a declared serve, the deploy watch\'s served commit is announced once', async () => {
  const posts: string[] = [];
  const { root, config } = await world('https://ntfy.example/yard');
  const webhook = async (text: string) => { posts.push(text); };
  const first = commit(root, 'base');
  await step(root, config, first, [], webhook, 'deploy');
  const merged = commit(root, 'GY-4');
  const work = [done('GY-4', 'Deploy watch', merged)];
  await step(root, config, merged, work, webhook, 'deploy');
  assert.deepEqual(posts, [`Mainworks owner/project: deployed ${merged.slice(0, 12)}\nGY-4 Deploy watch (${merged.slice(0, 12)})`]);
  await step(root, config, merged, work, webhook, 'deploy');
  assert.equal(posts.length, 1, 'not repeated after a restart');
});

test('integration:deploy-and-uat-alerts — a Slack incoming webhook gets {"text": ...}; any other receiver keeps the plain-text body', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response('ok'); }) as unknown as typeof fetch;
  await postAlert(fetcher, 'https://hooks.slack.com/services/T0/B0/x', 'Mainworks owner/project: deployed abc');
  await postAlert(fetcher, 'https://ntfy.example/yard', 'Mainworks owner/project: deployed abc');
  assert.deepEqual(JSON.parse(sent[0].init.body as string), { text: 'Mainworks owner/project: deployed abc' });
  assert.equal((sent[0].init.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal(sent[1].init.body, 'Mainworks owner/project: deployed abc');
  assert.equal((sent[1].init.headers as Record<string, string>)['Content-Type'], 'text/plain');
});

test('e2e:deploy-and-uat-alerts — a fake webhook receives the deployed message after a promotion and the UAT-failed message after a failing release candidate', async (t) => {
  const received: string[] = [];
  const { port } = await listen((request, response) => { let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => { received.push(body); response.end('ok'); }); }, t);
  const url = `http://127.0.0.1:${port}/alerts`;
  const { root, config } = await world(url);
  const webhook = (text: string) => postAlert(fetch, url, text);
  const base = commit(root, 'base');
  await step(root, config, base, [], webhook);
  const merged = commit(root, 'GY-7');
  const work = [done('GY-7', 'Faster search', merged)];
  // The promotion: the delivery watch now serves the merged commit.
  await step(root, config, merged, work, webhook);
  assert.deepEqual(received, [`Mainworks owner/project: deployed ${merged.slice(0, 12)}\nGY-7 Faster search (${merged.slice(0, 12)})`]);
  const candidate = commit(root, 'GY-8');
  await failedGate(root, merged, candidate);
  await step(root, config, merged, work, webhook);
  assert.equal(received.length, 2);
  assert.match(received[1], new RegExp(`UAT failed on candidate ${candidate.slice(0, 12)}; ${merged.slice(0, 12)} stays served\\. Failed: e2e:login, e2e:checkout$`));
});
