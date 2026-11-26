import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { CostSummary } from '../src/model/token-costs.js';
import type { Principal } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { listen } from './helpers/http-server.js';

// GY-3496: a flat-plan account on a model nobody priced reads 'flat plan', not 'price unknown', and
// the sessions an unmetered runtime ran collapse to one line per account, outside the totals.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const token = `coordinator-token-${'y'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, close: (() => Promise<void>) | undefined, url: string, root: string;

before(async () => {
  store = await withDatabase('usage-counted-or-flat'); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token }])));
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('usage-counted-or-flat', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  execFileSync('git', ['-C', root, 'init', '-q', '--initial-branch=main']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git']);
  await setupMaster(root, { url, token, cliPath: launcher, credentialDirectory: await temporaryDirectory('credentials', scratch), run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  const host = (await loadMasterConfig(root)).hostId, account = (name: string, runtime: string, model: string, extra = {}) => ({ name, runtime, model, credential: { host, home: null }, ...extra });
  const launch = (kind: string) => ({ name: kind, launch: { kind, args: [], environment: {}, homeVariable: null, modelFlag: null, login: null, loginFile: null } });
  await new AgentRegistry(store).mutate(coordinator, 'apply', { runtimes: ['opencode', 'muse', 'codex'].map(launch),
    models: [{ name: 'glm', id: 'glm-unpriced-9' }, { name: 'ember', id: null }],
    accounts: [account('zai-coding', 'opencode', 'glm', { plan: 'Coding plan', monthlyFee: 30 }), account('muse-sub', 'muse', 'ember'), account('codex-free', 'codex', 'glm')],
    roles: [], reason: 'flat plan fixture' }, randomUUID());
  const at = new Date().toISOString(), row = (id: string, account: string, runtime: string, reported: boolean, input: number) =>
    ({ id, work: null, role: 'reviewer', account, runtime, model: reported ? 'glm-unpriced-9' : null, reported, input, output: reported ? 1000 : 0, cacheRead: 0, cacheWrite: 0, at });
  const posted = await fetch(`${url}/api/usage`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [row('flat-1', 'zai-coding', 'opencode', true, 9000), row('muse-1', 'muse-sub', 'muse', false, 0), row('muse-2', 'muse-sub', 'muse', false, 0), row('free-1', 'codex-free', 'codex', true, 4000)] }) });
  assert.equal(posted.status, 200, await posted.text());
});
after(async () => { await close?.(); if (store) await store.close(); });

test('integration:usage-counted-or-flat — a fee account reads flat plan, an unpriced one price unknown, and unmetered sessions one line per account in master usage and the Costs API', async () => {
  const summary = await (await fetch(`${url}/api/costs`, { headers: { Authorization: `Bearer ${token}` } })).json() as CostSummary;
  const accounts = Object.fromEntries(summary.accounts.map(entry => [entry.name, entry.figure]));
  assert.equal(accounts['zai-coding'], 'flat plan', 'the fee account is priced as its plan');
  assert.equal(accounts['codex-free'], 'price unknown', 'an account with neither a price nor a fee');
  assert.deepEqual(summary.notMetered, ['muse-sub: 2 sessions not metered by muse']);
  assert.equal(summary.windows.all.flatTokens, 10_000);
  assert.equal(summary.windows.all.unpriced, 5000, 'only the account without a fee is unpriced');

  const { stdout } = await promisify(execFile)(process.execPath, [launcher, 'master', 'usage'], { cwd: root });
  const lines = stdout.split('\n');
  assert.ok(lines.some(text => text.startsWith('  zai-coding:') && text.includes('· flat plan · plan $30.00/month')), stdout);
  assert.ok(lines.some(text => text.startsWith('  codex-free:') && text.endsWith('· price unknown')), stdout);
  assert.equal(lines.filter(text => text.includes('not metered')).length, 1, stdout);
  assert.ok(lines.includes('  muse-sub: 2 sessions not metered by muse'), stdout);
  const totals = lines.find(text => text.startsWith('  All time:'))!;
  assert.ok(!/not (reported|metered)/.test(totals), `the totals line counts tokens only: ${totals}`);
});
