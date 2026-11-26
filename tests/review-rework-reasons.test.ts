import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTestStore } from './helpers/test-store.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { flowNumbers, type FlowItem } from '../src/flow-numbers.js';
import { FlowLine } from '../web/pages/work.js';
import type { Principal } from '../src/model.js';

// GY-3839: review and product-review rework (its prefix split on a hyphen, en or em dash, as headless reviewers write it) is grouped by a short label read from the first
// BLOCKING line of each verdict, and the top three labels show beside the rework causes.
const now = Date.parse('2026-11-25T12:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const tail = '. The verdict stands against the current head, so the item returns to a worker for the next round.';
const review = (key: string, minutesAgo: number, blocking: string[]) => ({ kind: 'rework', at: at(minutesAgo), binding: `abc${minutesAgo}:verdict:reviewer`,
  reason: `${key}: reviewer requested changes on abc${minutesAgo}: ${blocking.map(line => `BLOCKING: ${line}`).join('\n')}${tail}` });
const product = (key: string, minutesAgo: number, finding: string) => ({ kind: 'rework', at: at(minutesAgo), binding: `def${minutesAgo}:product-verdict:product`,
  reason: `${key}: the product review requested changes on def${minutesAgo}: BLOCKING: ${finding}${tail}` });
const item = (key: string, events: FlowItem['events']): FlowItem => ({ key, title: key, stage: 'build', stageEnteredAt: at(1), mergedAt: null, attempts: [], events });

test('integration:review-rework-reasons — review and product-review rework of the window is grouped by the label of its first BLOCKING line; the top three show in the flow and on Home', () => {
  const items = [
    item('GY-1', [
      review('GY-1', 30, ['tests/retry.test.ts:12 - no test covers the retry path', 'src/x.ts:4 - the page overflows at 390 px']),
      review('GY-1', 60, ['tests/flow.test.ts:40 — AC-2 is not met: master status never shows the label']),
    ]),
    item('GY-2', [
      review('GY-2', 90, ['src/a.ts:3 - missing test for the empty window']),
      product('GY-2', 120, 'Home — the flow table overflows the screen at 390 px'),
      product('GY-2', 150, 'Work page - the button no longer opens the item, a regression from GY-2000'),
    ]),
    item('GY-3', [
      review('GY-3', 200, ['tests/b.test.ts:9 – acceptance criterion AC-1 unmet: the count is never shown']),
      review('GY-3', 210, ['tests/b.test.ts:1 - the bound proof is missing']),
      // A merge trial's failure and an older verdict outside the window are not review reasons.
      { kind: 'rework', at: at(220), reason: "GY-3: the merge writer's trial of candidate abc failed: trial failed: tests/x.test.ts", binding: 'abc:merge-writer-trial-failed' },
      review('GY-3', 400, ['src/c.ts:1 - no test']),
    ]),
  ];
  const flow = flowNumbers(items, 6, now);
  assert.equal(flow.rework.review + flow.rework['product review'], 7);
  assert.deepEqual(flow.reviewReasons, [{ label: 'missing test', count: 3 }, { label: 'criterion unmet', count: 2 }, { label: 'UI defect', count: 1 }]);
  const html = renderToStaticMarkup(createElement(FlowLine, { flow: { '6h': flow, '24h': flow, '7d': flow, attention: null, asOf: at(0), ageSeconds: 0 } }));
  assert.match(html, /data-review-reasons[^>]*>[^<]*Missing test 3/);
  assert.match(html, /Criterion unmet 2/);
  assert.match(html, /UI defect 1/);
  assert.doesNotMatch(html, /Regression 1/, 'only the top three labels show');
});

// The e2e case: a running test install with one changes-requested review; master status shows its reason label.
const admin: Principal = { id: 'operator', role: 'admin' };
const adminToken = `operator-${'t'.repeat(32)}`;
const coordinatorToken = `coordinator-${'c'.repeat(32)}`;
let engine: Engine, url: string;
useTestStore('review-rework-reasons', { repository: 'owner/game', credentials: [{ ...admin, token: adminToken }, { id: 'master', role: 'coordinator', token: coordinatorToken }] }, ctx => {
  ({ engine, url } = ctx);
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
});

test('e2e:review-rework-reasons — with one changes-requested review, master status shows its reason label beside the rework causes', async () => {
  const masterApi = async (path: string) => {
    const response = await fetch(`${url}/api/${path}`, { headers: { Authorization: `Bearer ${coordinatorToken}` }, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    return JSON.parse(text);
  };
  const master: Principal = { id: 'graphyard-master-game-operator', role: 'operator-agent', scope: { repositories: ['owner/game'], workItems: ['*'] } };
  let work = await engine.execute(master, 'create', null, { reason: 'fixture', title: 'Reviewed change', type: 'chore', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:review-rework-reasons'] }] }, randomUUID());
  work = await engine.execute(master, 'ready', work.id, { reason: 'fixture', expectedRevision: work.revision }, randomUUID());
  await engine.execute(master, 'rework', work.id, { previousWorkerStopped: true, binding: `${'a'.repeat(40)}:verdict:reviewer`,
    reason: `${work.key}: reviewer requested changes on aaaaaaaaaaaa: BLOCKING: tests/retry.test.ts:12 - no test covers the retry path${tail}` }, randomUUID());

  const directory = await temporaryDirectory('review-rework-reasons');
  const config = masterConfigSchema.parse({ version: 1, url, repository: 'owner/game', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const root = await temporaryDirectory('review-rework-reasons-root');
  execFileSync('git', ['init', '-q', root]);
  const status = await masterStatusReport(root, config, masterApi, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
  assert.ok(status.flow, `flow is shown (${status.flowError})`);
  assert.equal(status.flow['6h'].rework.review, 1);
  assert.deepEqual(status.flow['6h'].reviewReasons, [{ label: 'missing test', count: 1 }]);
});
