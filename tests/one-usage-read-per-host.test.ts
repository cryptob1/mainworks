import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { observeAccount } from '../src/fleet.js';
import { hostAccountUsage, hostAccountsVariable } from '../src/host-accounts.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { selectAccount } from '../src/master/environments.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes } from '../src/model/registry.js';
import type { MasterConfig } from '../src/master/profiles.js';
import type { Principal } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';

// GY-3500: every install on a host read each login's usage from the provider on its own every
// cycle, so reads multiplied by installs, got refused, and installs disagreed about one account.
// The windows and their read time now live in the per-home host record: an install reads the
// provider only when that record is five minutes old or more.
const minute = 60_000;
const start = Date.now();
const iso = (at: number) => new Date(at).toISOString();
const windows = { five_hour: { utilization: 42, resets_at: iso(start + 3 * 60 * minute) }, seven_day: { utilization: 17, resets_at: iso(start + 5 * 24 * 60 * minute) } };
/** The stub usage endpoint: it counts every usage request it answers. */
function usageEndpoint() {
  const requests: string[] = [];
  // The same fetch carries the control-plane calls, which pass through uncounted.
  const fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return globalThis.fetch(url, init);
    requests.push(String(url));
    return new Response(JSON.stringify(windows));
  }) as unknown as typeof globalThis.fetch;
  return { requests, fetch };
}
const smoke = async () => ({ ok: true, error: null });
async function claudeHome(scratch: string) {
  const home = await temporaryDirectory('claude-shared', scratch);
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'token-shared', refreshToken: 'r', expiresAt: start + 86_400_000 } }));
  return home;
}
const claudeRuntime = () => structuredClone(proposedRuntimes.find(entry => entry.name === 'claude')!);

test('integration:one-usage-read-per-host — the provider is read once per home in five minutes, whichever install asks', async () => {
  const scratch = await temporaryDirectory('one-usage-read-integration');
  process.env[hostAccountsVariable] = await temporaryDirectory('host-accounts', scratch);
  const home = await claudeHome(scratch);
  // Two installs name the same login home under their own account names.
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [claudeRuntime()], models: [{ name: 'fixture', id: null }],
    accounts: [{ name: 'claude-one', runtime: 'claude', model: 'fixture', credential: { host: 'host', home } }, { name: 'claude-two', runtime: 'claude', model: 'fixture', credential: { host: 'host', home } }],
    roles: [{ name: 'worker', accounts: ['claude-one', 'claude-two'], concurrency: 1 }], reason: 'GY-3500 fixture',
  }, { actor: 'operator', at: iso(start - 86_400_000) }).registry;
  const endpoint = usageEndpoint();
  const observe = (name: string, at: number) => observeAccount(registry.accounts.find(account => account.name === name)!, registry.runtimes[0]!, { fetch: endpoint.fetch, smoke, now: () => at, opencodeAuth: null, opencodeModels: null }, registry.accounts);
  const readings = [];
  for (const [name, at] of [['claude-one', start], ['claude-two', start + minute], ['claude-one', start + 2 * minute], ['claude-two', start + 4 * minute]] as const)
    readings.push((await observe(name, at)).quota.usage);
  assert.equal(endpoint.requests.length, 1, 'four observations within five minutes read the provider once');
  for (const usage of readings) assert.deepEqual(usage.map(({ window, percent }) => ({ window, percent })), [{ window: '5h', percent: 42 }, { window: '7d', percent: 17 }]);
  assert.equal(hostAccountUsage(home)!.at, iso(start), 'the record carries the windows and their read time');
  // Concurrent observations on one home still read once.
  await Promise.all([observe('claude-one', start + 4.5 * minute), observe('claude-two', start + 4.5 * minute)]);
  assert.equal(endpoint.requests.length, 1);
  // Five minutes on, the record is stale: one install reads again and writes it back for the other.
  await observe('claude-two', start + 5 * minute);
  assert.equal(endpoint.requests.length, 2);
  await observe('claude-one', start + 6 * minute);
  assert.equal(endpoint.requests.length, 2);
  assert.equal(hostAccountUsage(home)!.at, iso(start + 5 * minute));
});

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const token = (install: number) => `${coordinator.id}-token-${install}-${'x'.repeat(24)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const hostId = 'shared-host';
interface Install { config: MasterConfig; registry: AgentRegistry; server: ReturnType<typeof server>; store: Store }
const installs: Install[] = [];
let home: string;

before(async () => {
  const stores = [await withDatabase('one-usage-read-1'), await withDatabase('one-usage-read-2')];
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('one-usage-read-per-host', join(process.cwd(), '.graphyard'));
  home = await claudeHome(scratch);
  for (const [index, repository] of ['owner/one', 'owner/two'].entries()) {
    const store = stores[index]!;
    await store.init();
    const http = server(new Engine(store, 120, repository), [{ ...coordinator, token: token(index + 1) }]);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const root = await temporaryDirectory(index === 0 ? 'one' : 'two', scratch);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main'); git('remote', 'add', 'origin', `https://github.com/${repository}.git`);
    await writeFile(join(root, 'README.md'), 'Fixture.\n');
    git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
    await setupMaster(root, { url, token: token(index + 1), cliPath: launcher, hostId, credentialDirectory: await temporaryDirectory(`credentials-${index}`, scratch), run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
    const registry = new AgentRegistry(store);
    await registry.mutate(coordinator, 'apply', {
      runtimes: [claudeRuntime()], models: [{ name: 'fixture', id: null }],
      accounts: [{ name: `claude-${index + 1}`, runtime: 'claude', model: 'fixture', credential: { host: hostId, home }, enabled: true }],
      roles: [{ name: 'worker', accounts: [`claude-${index + 1}`], concurrency: 4 }], reason: 'GY-3500 fixture',
    }, randomUUID());
    installs.push({ config: await loadMasterConfig(root), registry, server: http, store });
  }
});

after(async () => {
  for (const install of installs) {
    await new Promise<void>(resolve => { install.server.closeAllConnections?.(); install.server.close(() => resolve()); });
    await install.store.close();
  }
});

test('e2e:one-usage-read-per-host — two installs sharing one home each select twice within five minutes on one usage read', async () => {
  process.env[hostAccountsVariable] = await temporaryDirectory('host-accounts', join(process.cwd(), '.graphyard'));
  const endpoint = usageEndpoint();
  // Each selection is a minute apart, past any one install's own short probe cache.
  for (const [install, at] of [[0, start], [1, start + minute], [0, start + 2 * minute], [1, start + 3 * minute]] as const) {
    const selected = await selectAccount(installs[install]!.config, 'worker', { name: 'launch' }, { fetch: endpoint.fetch, smoke, now: () => at, opencodeAuth: null, opencodeModels: null });
    assert.equal(selected.account!.name, `claude-${install + 1}`);
    await selected.release!('selected for the usage-read fixture');
  }
  assert.equal(endpoint.requests.length, 1, 'the stub usage endpoint counted one request');
  const rows = await Promise.all(installs.map(async (install, index) => (await install.registry.snapshot(hostId)).accounts.find(account => account.name === `claude-${index + 1}`)!.usage));
  assert.deepEqual(rows[0]!.map(({ window, percent }) => ({ window, percent })), [{ window: '5h', percent: 42 }, { window: '7d', percent: 17 }]);
  assert.deepEqual(rows[1], rows[0], 'both installs show the same windows');
});
