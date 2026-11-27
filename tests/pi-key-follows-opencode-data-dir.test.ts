import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import { checkAccountLive } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { registryHeadlessLaunch, smokeRegistryAccount } from '../src/runner/roles.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { shellQuote } from '../src/shell-quote.js';
import { listen } from './helpers/http-server.js';
import { apiOk } from './helpers/api.js';

// GY-3832: a Pi account's key command names <home>/opencode/auth.json, and the OpenCode runtime may
// keep the login elsewhere: under the XDG_DATA_HOME its launch sets, in auth.json or in OpenCode 2.x's opencode.db.

const stores: Store[] = [];
const servers: (() => Promise<void>)[] = [];
after(async () => { for (const stop of servers) await stop(); for (const store of stores) await store.close(); });

function writeStubPi(binDir: string, name: string, expectedKey: string) {
  const file = join(binDir, `${name}.cjs`);
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.PI_CODING_AGENT_DIR;
if (!dir || !fs.existsSync(path.join(dir, 'auth.json')) || process.env.ZAI_API_KEY !== ${JSON.stringify(expectedKey)}) {
  console.error('No API key found for zai');
  process.exit(1);
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], model: 'glm-5.4' } }));
`);
  chmodSync(file, 0o755);
  return file;
}

function makePiRegistry(host: string, accounts: { name: string; home: string }[]): AgentRegistry {
  const basePi = proposedRuntimes.find(entry => entry.name === 'pi')!;
  const pi = structuredClone(basePi);
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [pi],
    models: [{ name: 'pi-glm-5.4', id: 'zai/glm-5.4' }],
    accounts: accounts.map(account => ({ name: account.name, runtime: 'pi', model: 'pi-glm-5.4', credential: { host, home: account.home } })),
    roles: [{ name: 'worker', accounts: [], concurrency: 1 }],
    reason: 'GY-3832 fixture',
  }, { actor: 'operator', at: '2026-11-25T06:00:00Z' }).registry;
}

/** The data directory OpenCode uses when launched on an account registered with `home`. */
function opencodeData(home: string) {
  const contract = proposedRuntimes.find(entry => entry.name === 'opencode')!.launch;
  const { environment } = registryHeadlessLaunch({ name: 'opencode-b', kind: 'opencode', home, key: null,
    fleet: { runtime: 'opencode', contract, model: 'glm', modelId: null, session: 'check', reason: 'check', role: 'worker' } });
  const directory = join(environment.XDG_DATA_HOME!, 'opencode');
  mkdirSync(directory, { recursive: true });
  return directory;
}
function seedAuthFile(directory: string, key: string) {
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key } }), { mode: 0o600 });
}
/** The login as OpenCode 2.x stores it. */
function seedDatabase(directory: string, key: string) {
  const database = new DatabaseSync(join(directory, 'opencode.db'));
  database.exec('CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)');
  database.prepare("INSERT INTO credential VALUES ('cred_1', 'zai-coding-plan', 'API key', ?, NULL, NULL, NULL, 1, 1)").run(JSON.stringify({ type: 'key', key }));
  database.close();
}
const keyCommand = (home: string) => JSON.stringify({ zai: { type: 'api_key', key: `!jq -r '."zai-coding-plan".key' ${shellQuote(join(home, 'opencode', 'auth.json'))}` } });

test('integration:pi-key-follows-opencode-data-dir — the Pi key resolves from the data directory the OpenCode launch uses', async () => {
  const base = await temporaryDirectory('pi-key-data-dir');
  process.env[hostAccountsVariable] = join(base, 'host-accounts');
  const cases = [
    { name: 'nested-file', data: (home: string) => opencodeData(join(home, 'opencode')), seed: seedAuthFile },
    { name: 'nested-db', data: (home: string) => opencodeData(join(home, 'opencode')), seed: seedDatabase },
    { name: 'direct-db', data: (home: string) => opencodeData(home), seed: seedDatabase },
    { name: 'direct-db-beside-auth-without-zai', data: (home: string) => opencodeData(home), seed: (directory: string, key: string) => { writeFileSync(join(directory, 'auth.json'), '{}'); seedDatabase(directory, key); } },
  ];
  for (const entry of cases) {
    const home = join(base, entry.name), piHome = join(base, `pi-${entry.name}`), key = `fixture-${entry.name}`;
    mkdirSync(piHome, { recursive: true });
    entry.seed(entry.data(home), key);
    writeFileSync(join(piHome, 'auth.json'), keyCommand(home), { mode: 0o600 });
    const registry = makePiRegistry('core', [{ name: 'pi-b', home: piHome }]);
    const pi = writeStubPi(base, `stub-${entry.name}`, key);
    const quota = await checkAccountLive(registry.accounts[0]!, registry.runtimes[0]!, { now: () => Date.parse('2026-11-25T07:00:00Z'), smoke: target => smokeRegistryAccount(target, { command: pi, timeoutMs: 10_000 }) }, 'zai/glm-5.4');
    assert.equal(quota.state, 'available', `${entry.name}: ${JSON.stringify(quota)}`);
  }
});

test('e2e:pi-key-follows-opencode-data-dir — on a running test install a Pi account check finds its key', async () => {
  const base = await temporaryDirectory('e2e-pi-key-opencode');
  process.env[hostAccountsVariable] = join(base, 'host-accounts');
  const bin = join(base, 'bin');
  const opencodeHome = join(base, 'opencode-b');
  const piHome = join(base, 'pi-b');
  for (const dir of [bin, piHome]) {
    mkdirSync(dir, { recursive: true });
  }

  const key = 'e2e-zai-key-from-opencode-b';
  seedDatabase(opencodeData(join(opencodeHome, 'opencode')), key);
  writeFileSync(join(piHome, 'auth.json'), keyCommand(opencodeHome), { mode: 0o600 });

  const piOk = writeStubPi(bin, 'pi-ok-e2e', key);

  const operator: Principal = { id: 'e2e-operator', role: 'admin', sessionKind: 'human' };
  const coordinator: Principal = { id: 'e2e-coord', role: 'coordinator', sessionKind: 'ai' };
  const credentials = [operator, coordinator].map(p => ({ ...p, token: `e2e-${p.id}-${'x'.repeat(32)}` }));
  const token = (actor: Principal) => credentials.find(entry => entry.id === actor.id)!.token;
  const store = await withDatabase('e2e-pi-key-follows-opencode-data-dir');
  stores.push(store);
  await store.init();
  const { url, close } = await listen(server(new Engine(store, 7200, 'owner/e2e-pi-key'), credentials));
  servers.push(close);

  const apiCall = (bearer: string, path: string, body?: unknown) => apiOk(url, bearer, path, { body });

  const piRuntime = structuredClone(proposedRuntimes.find(entry => entry.name === 'pi')!);
  await apiCall(token(operator), 'agent-registry/apply', {
    runtimes: [piRuntime],
    models: [{ name: 'pi-glm-5.4', id: 'zai/glm-5.4' }],
    accounts: [
      { name: 'pi-b', runtime: 'pi', model: 'pi-glm-5.4', credential: { host: 'e2e-host', home: piHome } },
    ],
    roles: [{ name: 'worker', accounts: ['pi-b'], concurrency: 1 }],
    reason: 'e2e pi key from opencode login fixture',
  });

  const credFile = join(base, 'coordinator.token');
  writeFileSync(credFile, `${token(coordinator)}\n`, { mode: 0o600 });
  const cfg: MasterConfig = masterConfigSchema.parse({
    version: 1,
    url,
    credentialFile: credFile,
    cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/e2e-pi-key',
    baseBranch: 'main',
    githubAppId: 1234,
    hostId: 'e2e-host',
    masterAgentName: 'graphyard-master-e2e',
    workers: [],
  });

  const checkApi = {
    read: (path: string) => apiCall(token(coordinator), path),
    write: (path: string, data: unknown) => apiCall(token(coordinator), path, data),
  };

  const line = await registryCommand(cfg, ['account', 'check', 'pi-b'], checkApi, {
    smoke: target => smokeRegistryAccount(target, { command: piOk, timeoutMs: 10_000 }),
  });
  assert.equal(line, 'pi-b passed its live check', `expected passing check line, got: ${String(line)}`);

  const fleet = await apiCall(token(coordinator), 'agent-registry?host=e2e-host');
  const piView = fleet.accounts.find((entry: any) => entry.name === 'pi-b');
  assert.ok(piView, 'registry view includes pi-b');
  assert.equal(piView.quota, 'available', `pi-b should be available, got: ${JSON.stringify(piView)}`);
  assert.equal(piView.loggedIn, true, 'pi-b is logged in');
});
