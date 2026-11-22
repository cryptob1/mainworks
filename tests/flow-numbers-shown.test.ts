import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { Principal } from '../src/model.js';

// GY-3624: the real control plane reads flow numbers from the ledger: four attempts ended in the
// last 24 hours, one sent back by the merge trial, so first-pass yield is 75%; an item has waited
// two hours in review, so master status raises one attention line naming review and that item.
const operator: Principal = { id: 'operator', role: 'admin' };
const token = `operator-${'t'.repeat(32)}`;
let store: Store, http: ReturnType<typeof server>, url: string;

before(async () => {
  store = await withDatabase('flow-numbers-shown'); await store.init();
  http = server(new Engine(store, 120, 'owner/game'), [{ ...operator, token }]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => {
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  if (store) await store.close();
});

const api = async (path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${path}-${Math.random()}` }, body: body ? JSON.stringify(body) : undefined });
  const json = await response.json() as any;
  if (!response.ok) throw new Error(`${path}: ${json?.error}`);
  return json;
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const attempt = (claimed: number, ended: number, end: string) => ({ epoch: 1, owner: 'worker', claimedAt: ago(claimed), endedAt: ago(ended), end });

test('e2e:flow-numbers-shown — /api/status and master status read 75% first pass, the review wait and one attention line from the ledger', async () => {
  const items = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const item = await api('work', { title: `Change ${n}`, why: 'Flow is visible.', simplest: 'One line.', type: 'feature', criteria: [{ id: 'AC-1', text: 'It works', proofs: ['e2e:fixture'] }] });
    await api(`work/${item.id}/ready`, { reason: 'Seeded' });
    items.push(item);
  }
  const set = (id: string, fields: Record<string, unknown>) => store.pool.query('UPDATE work_items SET document = document || $2::jsonb WHERE id=$1', [id, JSON.stringify(fields)]);
  const timeline = (attempts: unknown[]) => ({ pipeline: { attempts, submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } } });
  // Three merged on their first attempt.
  for (const [index, merged] of [30, 60, 90].entries())
    await set(items[index].id, { stage: 'done', stageEnteredAt: ago(merged), delivery: { mergedAt: ago(merged), mergeSha: 'a'.repeat(40), authorizationRevision: 1 }, ...timeline([attempt(merged + 60, merged + 30, 'submitted')]) });
  // One sent back by the merge trial, waiting for its next worker.
  await set(items[3].id, { stage: 'ready', stageEnteredAt: ago(100), ...timeline([attempt(200, 150, 'submitted')]) });
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload,created_at) VALUES($1,$2,$3,$4,$5)', [items[3].id, 'operator', 'rework',
    JSON.stringify({ details: { reason: `${items[3].key}: the merge writer's trial of candidate ${'b'.repeat(12)} failed: trial failed: tests/x.test.ts`, binding: `${'b'.repeat(40)}:merge-writer-trial-failed` } }), ago(100)]);
  // One waiting two hours in review.
  await set(items[4].id, { stage: 'review', stageEnteredAt: ago(120), ...timeline([attempt(180, 120, 'submitted')]) });

  const { flow } = await api('status');
  const day = flow['24h'];
  assert.deepEqual({ attempts: day.attempts, merges: day.merges, firstPassYield: day.firstPassYield }, { attempts: 4, merges: 3, firstPassYield: 0.75 });
  assert.equal(day.rework['merge trial'], 1);
  assert.deepEqual({ p90: day.stations.review.p90, oldest: day.stations.review.oldest.key }, { p90: 120, oldest: items[4].key });
  assert.deepEqual(Object.keys(flow).sort(), ['24h', '6h', '7d', 'attention']);

  const directory = await temporaryDirectory('flow-numbers-shown');
  const config = masterConfigSchema.parse({ version: 1, url, repository: 'owner/game', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master', workers: [], run: { masterHeartbeatMinutes: 240 } });
  const root = await temporaryDirectory('flow-numbers-shown-root');
  execFileSync('git', ['init', '-q', root]);
  const report = await masterStatusReport(root, config, api, async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${'b'.repeat(40)}\n`);
  assert.deepEqual(Object.keys(report.flow!).sort(), ['24h', '6h', '7d']);
  assert.equal(report.flow!['24h'].firstPassYield, 0.75);
  const lines = report.attention.filter(line => line.subject === 'review');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, `Review is slow: the slowest tenth waited 2 h over the last 24 hours. Oldest: ${items[4].key} Change 5, 2 h.`);
});
