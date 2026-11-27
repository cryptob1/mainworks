import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { checkAccountLive } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { shellQuote } from '../src/shell-quote.js';
import { listen } from './helpers/http-server.js';
import { apiOk } from './helpers/api.js';

// GY-3829: a Pi account set up against an OpenCode account reads its Z.AI key from the file
// OpenCode login actually writes, both on live account check and on role set; when the key command
// answers nothing, both report the file path it read.

const stores: Store[] = [];
const servers: (() => Promise<void>)[] = [];
after(async () => { for (const stop of servers) await stop(); for (const store of stores) await store.close(); });

function writeStubPi(binDir: string, name: string, mode: 'ok' | 'exhausted', expectedKey: string) {
  const file = join(binDir, `${name}.cjs`);
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.PI_CODING_AGENT_DIR;
if (!dir || !fs.existsSync(path.join(dir, 'auth.json')) || process.env.ZAI_API_KEY !== ${JSON.stringify(expectedKey)}) {
  console.error('No API key found for zai');
  process.exit(1);
}
if (${JSON.stringify(mode)} === 'exhausted') {
  console.error('Error: 429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-28 21:00:00"}');
  process.exit(1);
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], model: 'glm-5.4' } }));
`);
  chmodSync(file, 0o755);
  return file;
}

function makePiRegistry(host: string, accounts: { name: string; home: string }[], binDir?: string): AgentRegistry {
  const basePi = proposedRuntimes.find(entry => entry.name === 'pi')!;
  const pi = binDir
    ? { ...basePi, launch: { ...basePi.launch, environment: { ...basePi.launch.environment, PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}` } } }
    : structuredClone(basePi);
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [pi],
    models: [{ name: 'pi-glm-5.4', id: 'zai/glm-5.4' }],
    accounts: accounts.map(account => ({ name: account.name, runtime: 'pi', model: 'pi-glm-5.4', credential: { host, home: account.home } })),
    roles: [{ name: 'worker', accounts: [], concurrency: 1 }],
    reason: 'GY-3829 fixture',
  }, { actor: 'operator', at: '2026-11-25T06:00:00Z' }).registry;
}

test('integration:pi-key-from-opencode-login — a Pi account reads its Z.AI key from an OpenCode login home and names the file read when empty', async () => {
  const base = await temporaryDirectory('pi-key-opencode');
  process.env[hostAccountsVariable] = join(base, 'host-accounts');
  const bin = join(base, 'bin');
  const opencodeHome = join(base, 'opencode-b');
  const opencodeXdgFallback = join(base, 'opencode-c');
  const opencodeEmpty = join(base, 'opencode-empty');
  const piHome = join(base, 'pi-b');
  const piFallbackHome = join(base, 'pi-c');
  const piEmptyHome = join(base, 'pi-empty');
  for (const dir of [bin, join(opencodeHome, 'opencode'), join(opencodeXdgFallback, '.local', 'share', 'opencode'), opencodeEmpty, piHome, piFallbackHome, piEmptyHome]) {
    mkdirSync(dir, { recursive: true });
  }

  const keyB = 'zai-key-from-opencode-b';
  const keyC = 'zai-key-from-opencode-c';
  const opencodeBAuth = join(opencodeHome, 'opencode', 'auth.json');
  const opencodeCAuth = join(opencodeXdgFallback, 'opencode', 'auth.json');
  const opencodeEmptyAuth = join(opencodeEmpty, 'opencode', 'auth.json');

  // Seed opencode-b as `XDG_DATA_HOME=<home> opencode auth login` writes it.
  writeFileSync(opencodeBAuth, JSON.stringify({ 'zai-coding-plan': { type: 'api', key: keyB } }), { mode: 0o600 });
  // Seed opencode-c with OpenCode's default ~/.local/share/opencode/auth.json layout and a key command pointing at opencode/auth.json.
  writeFileSync(join(opencodeXdgFallback, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: keyC } }), { mode: 0o600 });

  const jqCommand = (file: string) => `!jq -r '.["zai-coding-plan"].key // empty' ${shellQuote(file)}`;
  writeFileSync(join(piHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: jqCommand(opencodeBAuth) } }), { mode: 0o600 });
  writeFileSync(join(piFallbackHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: jqCommand(opencodeCAuth) } }), { mode: 0o600 });
  writeFileSync(join(piEmptyHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: jqCommand(opencodeEmptyAuth) } }), { mode: 0o600 });

  const piOkB = writeStubPi(bin, 'pi-ok-b', 'ok', keyB);
  const piExhaustedB = writeStubPi(bin, 'pi-exhausted-b', 'exhausted', keyB);
  const piOkC = writeStubPi(bin, 'pi-ok-c', 'ok', keyC);

  const registry = makePiRegistry('core', [
    { name: 'pi-b', home: piHome },
    { name: 'pi-c', home: piFallbackHome },
    { name: 'pi-empty', home: piEmptyHome },
  ]);
  const piRuntime = registry.runtimes[0]!;
  const piB = registry.accounts.find(account => account.name === 'pi-b')!;
  const piC = registry.accounts.find(account => account.name === 'pi-c')!;
  const piEmpty = registry.accounts.find(account => account.name === 'pi-empty')!;

  const now = Date.parse('2026-11-25T06:30:00Z');
  // AC-1: live check resolves the Z.AI key from OpenCode's auth.json and returns available or exhausted, never No API key found.
  const avail = await checkAccountLive(piB, piRuntime, { now: () => now, smoke: target => smokeRegistryAccount(target, { command: piOkB, timeoutMs: 10_000 }) }, 'zai/glm-5.4');
  assert.equal(avail.state, 'available', `pi-b should be available, got ${JSON.stringify(avail)}`);
  assert.equal(avail.loggedIn, true);
  assert.doesNotMatch(avail.reason ?? '', /No API key found/i);

  const exh = await checkAccountLive(piB, piRuntime, { now: () => now + 1000, smoke: target => smokeRegistryAccount(target, { command: piExhaustedB, timeoutMs: 10_000 }) }, 'zai/glm-5.4');
  assert.equal(exh.state, 'exhausted', `pi-b should be exhausted, got ${JSON.stringify(exh)}`);
  assert.doesNotMatch(exh.reason ?? '', /No API key found/i);

  // Also resolves when OpenCode wrote under .local/share/opencode/auth.json inside the OpenCode home.
  const fallbackAvail = await checkAccountLive(piC, piRuntime, { now: () => now + 2000, smoke: target => smokeRegistryAccount(target, { command: piOkC, timeoutMs: 10_000 }) }, 'zai/glm-5.4');
  assert.equal(fallbackAvail.state, 'available', `pi-c should resolve fallback OpenCode auth file, got ${JSON.stringify(fallbackAvail)}`);

  // AC-2: when the key command answers nothing, both live check and role set name the file it read.
  const emptyCheck = await checkAccountLive(piEmpty, piRuntime, { now: () => now + 3000, smoke: target => smokeRegistryAccount(target, { command: piOkB, timeoutMs: 10_000 }) }, 'zai/glm-5.4');
  assert.equal(emptyCheck.loggedIn, false, `pi-empty should be not logged in, got ${JSON.stringify(emptyCheck)}`);
  assert.ok(emptyCheck.reason?.includes(opencodeEmptyAuth), `live check reason must name ${opencodeEmptyAuth}, got: ${emptyCheck.reason}`);
  assert.doesNotMatch(emptyCheck.reason ?? '', /No API key found/i);

  const api = { read: async () => registry, write: async (_path: string, data: unknown) => data };
  await assert.rejects(
    registryCommand({ hostId: 'core' }, ['role', 'set', 'worker', 'pi-empty', '--reason', 'build'], api),
    (error: Error) => {
      assert.ok(error.message.includes(opencodeEmptyAuth), `role set error must name ${opencodeEmptyAuth}, got: ${error.message}`);
      return true;
    },
  );
});

test('e2e:pi-key-from-opencode-login — on a running test install a Pi account check finds its key', async () => {
  const base = await temporaryDirectory('e2e-pi-key-opencode');
  process.env[hostAccountsVariable] = join(base, 'host-accounts');
  const bin = join(base, 'bin');
  const opencodeHome = join(base, 'opencode-b');
  const opencodeEmpty = join(base, 'opencode-empty');
  const piHome = join(base, 'pi-b');
  const piEmptyHome = join(base, 'pi-empty');
  for (const dir of [bin, join(opencodeHome, 'opencode'), opencodeEmpty, piHome, piEmptyHome]) {
    mkdirSync(dir, { recursive: true });
  }

  const key = 'e2e-zai-key-from-opencode-b';
  const opencodeAuth = join(opencodeHome, 'opencode', 'auth.json');
  const emptyAuth = join(opencodeEmpty, 'opencode', 'auth.json');
  writeFileSync(opencodeAuth, JSON.stringify({ 'zai-coding-plan': { type: 'api', key } }), { mode: 0o600 });
  writeFileSync(join(piHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: `!jq -r '.["zai-coding-plan"].key // empty' ${shellQuote(opencodeAuth)}` } }), { mode: 0o600 });
  writeFileSync(join(piEmptyHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: `!jq -r '.["zai-coding-plan"].key // empty' ${shellQuote(emptyAuth)}` } }), { mode: 0o600 });

  const piOk = writeStubPi(bin, 'pi-ok-e2e', 'ok', key);

  const operator: Principal = { id: 'e2e-operator', role: 'admin', sessionKind: 'human' };
  const coordinator: Principal = { id: 'e2e-coord', role: 'coordinator', sessionKind: 'ai' };
  const credentials = [operator, coordinator].map(p => ({ ...p, token: `e2e-${p.id}-${'x'.repeat(32)}` }));
  const token = (actor: Principal) => credentials.find(entry => entry.id === actor.id)!.token;
  const store = await withDatabase('e2e-pi-key-from-opencode-login');
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
      { name: 'pi-empty', runtime: 'pi', model: 'pi-glm-5.4', credential: { host: 'e2e-host', home: piEmptyHome } },
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

  const emptyLine = String(await registryCommand(cfg, ['account', 'check', 'pi-empty'], checkApi, {
    smoke: target => smokeRegistryAccount(target, { command: piOk, timeoutMs: 10_000 }),
  }));
  assert.ok(emptyLine.includes(emptyAuth), `empty key check line must name ${emptyAuth}, got: ${emptyLine}`);
  assert.doesNotMatch(emptyLine, /No API key found/i);
});
