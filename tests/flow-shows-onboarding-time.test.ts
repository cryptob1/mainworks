import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
import type { Principal } from '../src/model.js';
import { listen } from './helpers/http-server.js';
import { apiOk } from './helpers/api.js';
import { FlowLine } from '../web/pages/work.js';

// GY-4059: the flow numbers show each connected repository's onboarding time, from its connection
// (the control plane's first schema record or first work item) to its first merged change.
const admin: Principal = { id: 'operator', role: 'admin' };
const adminToken = `operator-${'t'.repeat(32)}`;
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
const repository = 'owner/onboarded';
let store: Store, close: (() => Promise<void>) | undefined, url: string, repoRoot: string;

before(async () => {
  ({ root: repoRoot } = await gitRepo({ label: 'flow-onboarding-repo', files: { 'base.txt': 'base\n' }, message: 'add base.txt' }));
  store = await withDatabase('flow-shows-onboarding-time'); await store.init();
  ({ url, close } = await listen(server(new Engine(store, 120, repository), [{ ...admin, token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }])));
});

after(async () => {
  await close?.();
  if (store) await store.close();
});

const call = (token: string, path: string, body?: unknown) => apiOk(url, token, path, { body, signal: AbortSignal.timeout(30_000) });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function report() {
  const directory = await temporaryDirectory('flow-onboarding-cfg');
  const config = masterConfigSchema.parse({ version: 1, url, repository, credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  return masterStatusReport(repoRoot, config, (path: string) => call(coordinatorToken, path), async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${git(repoRoot, 'rev-parse', 'HEAD')}\n`);
}

test('integration:flow-shows-onboarding-time — connection to first merge is shown, and a repository not yet merged shows its wait', async () => {
  // The repository was connected 90 minutes ago.
  await store.pool.query('UPDATE graphyard_schema SET applied_at = $1', [ago(90)]);

  forgetFlow(store);
  const waiting = (await call(adminToken, 'flow')).onboarding;
  assert.equal(waiting.length, 1, 'one line for the one connected repository');
  assert.equal(waiting[0].repository, repository);
  assert.equal(waiting[0].firstMergeAt, null);
  assert.equal(waiting[0].waiting, true);
  assert.ok(Math.abs(waiting[0].minutes - 90) <= 1, `expected ~90 min waiting, got ${waiting[0].minutes}`);

  // Its first change merged 78 minutes ago: 12 minutes from connection; a later merge changes nothing.
  for (const mergedMinutesAgo of [78, 20]) {
    const item = await call(adminToken, 'work', { title: `Merge ${mergedMinutesAgo}`, why: 'Onboarding is measured.', simplest: 'One line.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] });
    await store.pool.query('UPDATE work_items SET document = document || $2::jsonb WHERE id=$1', [item.id, JSON.stringify({
      stage: 'done', stageEnteredAt: ago(mergedMinutesAgo), delivery: { mergedAt: ago(mergedMinutesAgo), mergeSha: 'a'.repeat(40), authorizationRevision: 1 },
      nextAction: null, queue: null, lease: null, actionQueue: { actions: [] }, sessions: [] })]);
  }

  forgetFlow(store);
  const flow = await call(adminToken, 'flow');
  const [line] = flow.onboarding;
  assert.equal(line.repository, repository);
  assert.equal(line.waiting, false);
  assert.ok(line.firstMergeAt, 'the first merge is named');
  assert.ok(Math.abs(line.minutes - 12) <= 1, `expected ~12 min onboarding, got ${line.minutes}`);

  const status = await report();
  assert.ok(status.flow, `flow is shown (${status.flowError})`);
  assert.deepEqual(status.flow.onboarding, flow.onboarding, 'master status flow carries the onboarding line');

  const html = renderToStaticMarkup(createElement(FlowLine, { flow }));
  assert.match(html, /data-flow-onboarding/);
  assert.match(html, /owner\/onboarded: 12 min from connection to first merge/);
  const waitingHtml = renderToStaticMarkup(createElement(FlowLine, { flow: { ...flow, onboarding: waiting } }));
  assert.match(waitingHtml, /owner\/onboarded: no merge yet, waiting 1 h 30 min/);
});
