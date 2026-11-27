import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { useTestStore } from './helpers/test-store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { forgetFlow } from '../src/server/flow.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { Principal } from '../src/model.js';
import { apiOk } from './helpers/api.js';

// GY-3699: master status reads the flow numbers from GET /api/flow with the master's coordinator
// credential; a failed flow read names its reason and the rest of the report still answers.
const admin: Principal = { id: 'operator', role: 'admin' };
const adminToken = `operator-${'t'.repeat(32)}`;
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
let store: Store, url: string;

useTestStore('master-status-shows-flow', { repository: 'owner/game', credentials: [{ ...admin, token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }] }, ctx => { ({ store, url } = ctx); });

const call = (token: string, path: string, body?: unknown) => apiOk(url, token, path, { body, signal: AbortSignal.timeout(30_000) });
// The master's own read: its coordinator credential and the 30 s timeout every status read uses (src/cli/master/session.ts).
const masterApi = (path: string) => call(coordinatorToken, path);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function mergedItem() {
  const item = await call(adminToken, 'work', { title: 'Merged change', why: 'Flow is visible.', simplest: 'One line.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] });
  await call(adminToken, `work/${item.id}/ready`, { reason: 'Seeded' });
  await store.pool.query('UPDATE work_items SET document = document || $2::jsonb WHERE id=$1', [item.id, JSON.stringify({
    stage: 'done', stageEnteredAt: ago(30), delivery: { mergedAt: ago(30), mergeSha: 'a'.repeat(40), authorizationRevision: 1 }, nextAction: null, queue: null, lease: null, actionQueue: { actions: [] }, sessions: [],
    pipeline: { attempts: [{ epoch: 1, owner: 'worker', claimedAt: ago(90), endedAt: ago(60), end: 'submitted' }], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } } })]);
  return item;
}

async function report() {
  const directory = await temporaryDirectory('master-status-shows-flow');
  const config = masterConfigSchema.parse({ version: 1, url, repository: 'owner/game', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const root = await temporaryDirectory('master-status-shows-flow-root');
  execFileSync('git', ['init', '-q', root]);
  return masterStatusReport(root, config, masterApi, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
}

test('e2e:master-status-shows-flow — after a merge, master status shows the flow numbers with the attempt counted', async () => {
  await mergedItem();
  assert.equal('flow' in await masterApi('status'), false, '/api/status carries no flow');
  const status = await report();
  assert.ok(status.flow, `flow is shown (${status.flowError})`);
  assert.equal(status.flowError, null);
  const day = status.flow['24h'];
  assert.ok(day.attempts >= 1, 'at least one attempt is counted');
  assert.ok(day.merges >= 1);
  for (const field of ['attemptsPerHour', 'firstPassYield', 'rework', 'stations', 'flakyRate', 'reverts'] as const) assert.ok(field in day, `24h carries ${field}`);
});

test('integration:master-status-shows-flow — the master reads /api/flow for its numbers; a failed read names its reason and the rest still answers', async () => {
  const status = await report();
  assert.ok(status.flow, `flow is shown (${status.flowError})`);
  assert.deepEqual(Object.keys(status.flow).sort(), ['24h', '6h', '7d', 'onboarding']);
  assert.equal(typeof status.flow['24h'].attemptsPerHour, 'number');

  // The flow read fails as production's did: its query ran past the statement timeout.
  const fleet = store.fleet.bind(store);
  store.fleet = () => Promise.reject(new Error('canceling statement due to statement timeout'));
  forgetFlow(store);
  try {
    const failed = await report();
    assert.equal(failed.flow, null);
    assert.match(failed.flowError ?? '', /^The flow numbers could not be read: /);
    assert.ok(Array.isArray(failed.items) && failed.controlPlane, 'the rest of master status still answers');
  } finally {
    store.fleet = fleet;
  }
});
