import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { smokeRegistryAccount } from '../src/runner/roles.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterCredentialMask, sessionMountNamespaceWorks } from '../src/master/confinement.js';
import { masterSessionConfinement } from '../src/master/launch.js';
import { listen } from './helpers/http-server.js';

// GY-3806: live checks of agy and Pi accounts get a writable account home and a scratch home they
// can create, returning a login verdict (available, exhausted or not logged in) instead of a check
// environment fault.

const stores: Store[] = [];
const servers: (() => Promise<void>)[] = [];
after(async () => { for (const stop of servers) await stop(); for (const store of stores) await store.close(); });

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function writeStubAgy(binDir: string, mode: 'ok' | 'exhausted' | 'logged-out' = 'ok') {
  const file = join(binDir, `agy-${mode}.cjs`);
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
if (!home) { console.error('HOME is not set'); process.exit(1); }
const cfgDir = path.join(home, '.gemini', 'antigravity-cli');
if (path.resolve(process.cwd()) === path.resolve(home)) {
  console.error(\`E1124 09:53:53.068568 111 file_watcher.go:194] skipping empty or temporary file \${home}/.gemini\`);
  process.exit(1);
}
for (const dir of [process.env.TMPDIR, process.env.XDG_CACHE_HOME, process.env.XDG_CONFIG_HOME].filter(Boolean)) {
  try {
    const probe = path.join(dir, 'agy-probe-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    console.error(\`scratch dir \${dir} unwritable: \${err.code}: \${err.message}\`);
    process.exit(1);
  }
}
const tokenPath = path.join(cfgDir, 'antigravity-oauth-token');
if (${JSON.stringify(mode)} === 'logged-out' || !fs.existsSync(tokenPath)) {
  console.error('Authentication required. Please log in first.');
  process.exit(1);
}
try {
  const lock = path.join(cfgDir, 'smoke.lock');
  fs.writeFileSync(lock, 'lock');
  fs.unlinkSync(lock);
} catch (err) {
  console.error(\`EROFS: read-only file system, open '\${path.join(cfgDir, 'smoke.lock')}'\`);
  process.exit(1);
}
if (${JSON.stringify(mode)} === 'exhausted') {
  console.error('Individual quota reached. Resets in 1h30m.');
  process.exit(1);
}
console.log('OK');
`);
  chmodSync(file, 0o755);
  return file;
}

function writeStubPi(binDir: string, mode: 'ok' | 'exhausted' | 'logged-out' = 'ok') {
  const file = join(binDir, `pi-${mode}.cjs`);
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.PI_CODING_AGENT_DIR;
if (!dir) { console.error('PI_CODING_AGENT_DIR not set'); process.exit(1); }
const authPath = path.join(dir, 'auth.json');
if (${JSON.stringify(mode)} === 'logged-out' || !fs.existsSync(authPath)) {
  console.error('Authentication required: No API key found for zai');
  process.exit(1);
}
try {
  const lock = path.join(dir, 'settings.json.lock');
  fs.mkdirSync(lock);
  fs.rmdirSync(lock);
  // Real Pi may also write auth/config files in PI_CODING_AGENT_DIR and XDG config/cache dirs.
  fs.appendFileSync(authPath, '');
  if (process.env.XDG_CONFIG_HOME) {
    const p = path.join(process.env.XDG_CONFIG_HOME, 'pi-probe-' + process.pid);
    fs.writeFileSync(p, 'ok');
    fs.unlinkSync(p);
  }
} catch (err) {
  console.error(\`Warning: Invalid settings file \${path.join(dir, 'settings.json')}: \${err.code}: read-only file system, mkdir '\${path.join(dir, 'settings.json.lock')}'\`);
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

function makeRegistry(agyHome: string, piHome: string, agyCmd: string, piCmd: string): AgentRegistry {
  const piRuntime = structuredClone(proposedRuntimes.find(entry => entry.name === 'pi')!);
  piRuntime.launch.kind = 'pi';
  const agyRuntime = structuredClone(proposedRuntimes.find(entry => entry.name === 'agy') ?? {
    name: 'agy',
    description: 'Antigravity CLI',
    launch: { kind: 'agy', args: [], environment: {}, homeVariable: 'AGY_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null },
  });
  agyRuntime.launch.kind = 'agy';
  const at = '2026-11-24T22:00:00Z';
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [agyRuntime, piRuntime],
    models: [{ name: 'agy-default', id: 'gemini-3-pro' }, { name: 'glm', id: 'zai/glm-5.4' }],
    accounts: [
      { name: 'agy', runtime: 'agy', model: 'agy-default', credential: { host: 'core', home: agyHome } },
      { name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host: 'core', home: piHome } },
    ],
    roles: [{ name: 'worker', accounts: ['agy', 'pi-a'], concurrency: 1 }],
    reason: 'GY-3806 fixture',
  }, { actor: 'operator', at }).registry;
}

test('integration:account-check-writable-home — agy and Pi live checks get a writable account home and unique scratch home when homes are read-only and return login verdicts', async () => {
  const base = await temporaryDirectory('ac-writable-home');
  process.env[hostAccountsVariable] = join(base, 'host-accounts');
  const agyHome = join(base, 'agy-home'), piHome = join(base, 'pi-home'), bin = join(base, 'bin'), tmp = join(base, 'tmp'), roXdg = join(base, 'ro-xdg');
  for (const dir of [agyHome, piHome, bin, tmp, roXdg]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agyHome, 'antigravity-oauth-token'), 'oauth-token-fixture');
  writeFileSync(join(agyHome, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  writeFileSync(join(piHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'fixture-key' } }));
  writeFileSync(join(piHome, 'settings.json'), JSON.stringify({ defaultProvider: 'zai', defaultModel: 'glm-5.4' }));

  // Simulate a fixed /tmp/mainworks-agy-smoke-agy directory that cannot be removed/reused, and read-only account homes + read-only XDG_CONFIG_HOME.
  const fixedAgyPath = join(tmp, 'mainworks-agy-smoke-agy');
  mkdirSync(fixedAgyPath, { recursive: true });
  writeFileSync(join(fixedAgyPath, 'occupied'), 'locked');
  chmodSync(fixedAgyPath, 0o500);
  chmodSync(agyHome, 0o500);
  chmodSync(piHome, 0o500);
  chmodSync(roXdg, 0o500);

  const savedTmp = process.env.TMPDIR, savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.TMPDIR = tmp;
  process.env.XDG_CONFIG_HOME = roXdg;
  const now = Date.parse('2026-11-24T22:42:00Z');
  try {
    const agyOk = writeStubAgy(bin, 'ok'), agyExhausted = writeStubAgy(bin, 'exhausted'), agyLoggedOut = writeStubAgy(bin, 'logged-out');
    const piOk = writeStubPi(bin, 'ok'), piExhausted = writeStubPi(bin, 'exhausted'), piLoggedOut = writeStubPi(bin, 'logged-out');
    const registry = makeRegistry(agyHome, piHome, agyOk, piOk);
    const agyAccount = registry.accounts.find(a => a.name === 'agy')!;
    const agyRuntime = registry.runtimes.find(r => r.name === 'agy')!;
    const piAccount = registry.accounts.find(a => a.name === 'pi-a')!;
    const piRuntime = registry.runtimes.find(r => r.name === 'pi')!;

    // agy: available, exhausted, not logged in — never a check environment fault.
    const agyAvail = await checkAccountLive(agyAccount, agyRuntime, { now: () => now, smoke: target => smokeRegistryAccount(target, { command: agyOk, timeoutMs: 10_000 }) }, 'gemini-3-pro');
    assert.equal(agyAvail.state, 'available', `agy should be available, got ${JSON.stringify(agyAvail)}`);
    assert.equal(agyAvail.fault ?? null, null, 'agy available has no check environment fault');

    const agyExh = await checkAccountLive(agyAccount, agyRuntime, { now: () => now + 1000, smoke: target => smokeRegistryAccount(target, { command: agyExhausted, timeoutMs: 10_000 }) }, 'gemini-3-pro');
    assert.equal(agyExh.state, 'exhausted', `agy should be exhausted, got ${JSON.stringify(agyExh)}`);
    assert.equal(agyExh.fault ?? null, null, 'agy exhausted has no check environment fault');

    const agyOut = await checkAccountLive(agyAccount, agyRuntime, { now: () => now + 2000, smoke: target => smokeRegistryAccount(target, { command: agyLoggedOut, timeoutMs: 10_000 }) }, 'gemini-3-pro');
    assert.equal(agyOut.loggedIn, false, `agy should be not logged in, got ${JSON.stringify(agyOut)}`);
    assert.equal(agyOut.fault ?? null, null, 'agy logged-out has no check environment fault');

    // Pi: available, exhausted, not logged in — never a check environment fault.
    const piAvail = await checkAccountLive(piAccount, piRuntime, { now: () => now, smoke: target => smokeRegistryAccount(target, { command: piOk, timeoutMs: 10_000 }) }, 'zai/glm-5.4');
    assert.equal(piAvail.state, 'available', `pi-a should be available, got ${JSON.stringify(piAvail)}`);
    assert.equal(piAvail.fault ?? null, null, 'pi-a available has no check environment fault');

    const piExh = await checkAccountLive(piAccount, piRuntime, { now: () => now + 1000, smoke: target => smokeRegistryAccount(target, { command: piExhausted, timeoutMs: 10_000 }) }, 'zai/glm-5.4');
    assert.equal(piExh.state, 'exhausted', `pi-a should be exhausted, got ${JSON.stringify(piExh)}`);
    assert.equal(piExh.fault ?? null, null, 'pi-a exhausted has no check environment fault');

    const piOut = await checkAccountLive(piAccount, piRuntime, { now: () => now + 2000, smoke: target => smokeRegistryAccount(target, { command: piLoggedOut, timeoutMs: 10_000 }) }, 'zai/glm-5.4');
    assert.equal(piOut.loggedIn, false, `pi-a should be not logged in, got ${JSON.stringify(piOut)}`);
    assert.equal(piOut.fault ?? null, null, 'pi-a logged-out has no check environment fault');
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    try { chmodSync(fixedAgyPath, 0o700); } catch { /* may have been cleaned up */ }
    try { chmodSync(agyHome, 0o700); } catch { /* ignore */ }
    try { chmodSync(piHome, 0o700); } catch { /* ignore */ }
    try { chmodSync(roXdg, 0o700); } catch { /* ignore */ }
  }
});

test('integration:account-check-writable-home — agy and Pi live checks return a login verdict inside core bwrap confinement', async () => {
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');
  mkdirSync(join(repoRoot, '.graphyard'), { recursive: true });
  const holder = await temporaryDirectory('ac-confined-core', join(repoRoot, '.graphyard'));
  try {
    const root = join(holder, 'checkout');
    const agyHome = join(holder, 'coding_agents', 'agy');
    const piHome = join(holder, 'coding_agents', 'pi-a');
    const masterHome = join(holder, 'coding_agents', 'claude-master');
    const bin = join(holder, 'bin');
    const configHome = join(holder, 'config');
    const masterToken = join(configHome, 'install', 'tokens', 'coordinator.token');
    for (const dir of [root, agyHome, piHome, masterHome, bin, dirname(masterToken)]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'seed');
    writeFileSync(masterToken, 'coord-token\n', { mode: 0o600 });
    writeFileSync(join(agyHome, 'antigravity-oauth-token'), 'oauth-token-fixture');
    writeFileSync(join(agyHome, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    writeFileSync(join(piHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'fixture-key' } }));
    writeFileSync(join(piHome, 'settings.json'), JSON.stringify({ defaultProvider: 'zai', defaultModel: 'glm-5.4' }));

    const agyOk = writeStubAgy(bin, 'ok');
    const piOk = writeStubPi(bin, 'ok');
    const probeScript = join(holder, 'run-confined-checks.mjs');
    writeFileSync(probeScript, `
import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { checkAccountLive } from ${JSON.stringify(join(repoRoot, 'src/fleet.ts'))};
import { smokeRegistryAccount } from ${JSON.stringify(join(repoRoot, 'src/runner/roles.ts'))};
import { hostAccountsVariable } from ${JSON.stringify(join(repoRoot, 'src/host-accounts.ts'))};
import { applyRegistryMutation } from ${JSON.stringify(join(repoRoot, 'src/model-boundary/registry.ts'))};
import { emptyRegistry, proposedRuntimes } from ${JSON.stringify(join(repoRoot, 'src/model/registry.ts'))};

assert.throws(() => accessSync(${JSON.stringify(agyHome)}, constants.W_OK), 'agy home is read-only inside confinement');
assert.throws(() => accessSync(${JSON.stringify(piHome)}, constants.W_OK), 'pi home is read-only inside confinement');
process.env[hostAccountsVariable] = '/tmp/host-accounts-confined';
const piRuntime = structuredClone(proposedRuntimes.find(e => e.name === 'pi'));
const agyRuntime = structuredClone(proposedRuntimes.find(e => e.name === 'agy') ?? { name: 'agy', description: 'agy', launch: { kind: 'agy', args: [], environment: {}, homeVariable: 'AGY_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null } });
agyRuntime.launch.kind = 'agy';
const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
  runtimes: [agyRuntime, piRuntime],
  models: [{ name: 'agy-default', id: 'gemini-3-pro' }, { name: 'glm', id: 'zai/glm-5.4' }],
  accounts: [
    { name: 'agy', runtime: 'agy', model: 'agy-default', credential: { host: 'core', home: ${JSON.stringify(agyHome)} } },
    { name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host: 'core', home: ${JSON.stringify(piHome)} } },
  ],
  roles: [{ name: 'worker', accounts: ['agy', 'pi-a'], concurrency: 1 }],
  reason: 'confined live check fixture',
}, { actor: 'operator', at: '2026-11-24T22:00:00Z' }).registry;

const agyAccount = registry.accounts.find(a => a.name === 'agy');
const piAccount = registry.accounts.find(a => a.name === 'pi-a');
const agyRes = await checkAccountLive(agyAccount, registry.runtimes.find(r => r.name === 'agy'), { smoke: t => smokeRegistryAccount(t, { command: ${JSON.stringify(agyOk)}, timeoutMs: 15_000 }) }, 'gemini-3-pro');
const piRes = await checkAccountLive(piAccount, registry.runtimes.find(r => r.name === 'pi'), { smoke: t => smokeRegistryAccount(t, { command: ${JSON.stringify(piOk)}, timeoutMs: 15_000 }) }, 'zai/glm-5.4');
assert.equal(agyRes.state, 'available', 'agy confined verdict: ' + JSON.stringify(agyRes));
assert.equal(agyRes.fault ?? null, null, 'agy confined fault: ' + JSON.stringify(agyRes));
assert.equal(piRes.state, 'available', 'pi-a confined verdict: ' + JSON.stringify(piRes));
assert.equal(piRes.fault ?? null, null, 'pi-a confined fault: ' + JSON.stringify(piRes));
console.log(JSON.stringify({ agy: agyRes.state, pi: piRes.state }));
`);

    const confinement = await masterSessionConfinement(
      'claude',
      root,
      { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true },
      [masterHome, dirname(masterToken)],
      { CLAUDE_CONFIG_DIR: masterHome, GRAPHYARD_CONFIG_HOME: configHome },
      masterCredentialMask({ credentialFile: masterToken }, [masterHome], configHome),
    );
    const ran = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1), process.execPath, '--import', 'tsx', probeScript], {
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
      cwd: repoRoot,
    });
    assert.equal(ran.status, 0, `confined live checks failed:\nstdout: ${ran.stdout}\nstderr: ${ran.stderr}`);
    const parsed = JSON.parse(ran.stdout.trim().split('\n').at(-1)!);
    assert.deepEqual(parsed, { agy: 'available', pi: 'available' });
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test('e2e:account-check-writable-home — on a running test install an agy account check shows a login verdict in master status', async () => {
  const base = await temporaryDirectory('e2e-ac-writable-home');
  process.env[hostAccountsVariable] = join(base, 'host-accounts');
  const agyHome = join(base, 'agy-home'), bin = join(base, 'bin'), tmp = join(base, 'tmp'), root = join(base, 'repo');
  for (const dir of [agyHome, bin, tmp, root]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(agyHome, 'antigravity-oauth-token'), 'oauth-token-fixture');
  writeFileSync(join(agyHome, 'settings.json'), JSON.stringify({ theme: 'dark' }));

  const agyOk = writeStubAgy(bin, 'ok');
  const fixedAgyPath = join(tmp, 'mainworks-agy-smoke-agy');
  mkdirSync(fixedAgyPath, { recursive: true });
  chmodSync(fixedAgyPath, 0o500);
  chmodSync(agyHome, 0o500);

  const operator: Principal = { id: 'e2e-operator', role: 'admin', sessionKind: 'human' };
  const coordinator: Principal = { id: 'e2e-coord', role: 'coordinator', sessionKind: 'ai' };
  const credentials = [operator, coordinator].map(p => ({ ...p, token: `e2e-${p.id}-${'x'.repeat(32)}` }));
  const token = (actor: Principal) => credentials.find(entry => entry.id === actor.id)!.token;
  const store = await withDatabase('e2e-account-check-writable-home');
  stores.push(store);
  await store.init();
  const { url, close } = await listen(server(new Engine(store, 7200, 'owner/e2e-agy-check'), credentials));
  servers.push(close);

  const apiCall = async (bearer: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, body === undefined
      ? { headers: { Authorization: `Bearer ${bearer}` } }
      : { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    const parsed = await response.json() as any;
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(parsed)}`);
    return parsed;
  };

  const agyRuntime = structuredClone(proposedRuntimes.find(entry => entry.name === 'agy') ?? {
    name: 'agy',
    description: 'Antigravity CLI',
    launch: { kind: 'agy', args: [], environment: {}, homeVariable: 'AGY_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null },
  });
  agyRuntime.launch.kind = 'agy';
  await apiCall(token(operator), 'agent-registry/apply', {
    runtimes: [agyRuntime],
    models: [{ name: 'agy-default', id: 'gemini-3-pro' }],
    accounts: [{ name: 'agy', runtime: 'agy', model: 'agy-default', credential: { host: 'e2e-host', home: agyHome } }],
    roles: [{ name: 'worker', accounts: ['agy'], concurrency: 1 }],
    reason: 'e2e agy writable home fixture',
  });

  const credFile = join(base, 'coordinator.token');
  writeFileSync(credFile, `${token(coordinator)}\n`, { mode: 0o600 });
  const cfg: MasterConfig = masterConfigSchema.parse({
    version: 1,
    url,
    credentialFile: credFile,
    cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/e2e-agy-check',
    baseBranch: 'main',
    githubAppId: 1234,
    hostId: 'e2e-host',
    masterAgentName: 'graphyard-master-e2e',
    workers: [],
  });

  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    const checkApi = {
      read: (path: string) => apiCall(token(coordinator), path),
      write: (path: string, data: unknown) => apiCall(token(coordinator), path, data),
    };
    const line = await registryCommand(cfg, ['account', 'check', 'agy'], checkApi, {
      smoke: target => smokeRegistryAccount(target, { command: agyOk, timeoutMs: 10_000 }),
    });
    assert.equal(line, 'agy passed its live check', `expected passing check line, got: ${String(line)}`);

    const status = await masterStatusReport(root, cfg, path => apiCall(token(coordinator), path), async () => '');
    const fleet = await apiCall(token(coordinator), 'agent-registry?host=e2e-host');
    const agyView = fleet.accounts.find((entry: any) => entry.name === 'agy');
    assert.ok(agyView, 'registry view includes the agy account');
    assert.equal(agyView.quota, 'available', `agy account should be available, got: ${JSON.stringify(agyView)}`);
    assert.equal(agyView.loggedIn, true, 'agy account is logged in');
    assert.equal(agyView.fault ?? null, null, 'agy account has no check environment fault');
    assert.ok(agyView.checkedLive, 'agy account records when it was checked live');
    assert.ok(status.accounts.some(entry => entry.startsWith('agy:')), `master status lists agy: ${JSON.stringify(status.accounts)}`);
    assert.ok(!status.attention.some(item => item.subject === 'account agy' && /check environment fault/i.test(item.text)), 'no check environment fault attention for agy');
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    try { chmodSync(fixedAgyPath, 0o700); } catch { /* may have been cleaned up */ }
    try { chmodSync(agyHome, 0o700); } catch { /* ignore */ }
  }
});
