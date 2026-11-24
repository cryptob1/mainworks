import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAccountLive, observeAccount } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, foldObservation, proposedRuntimes, type AgentRegistry, type FleetAccount } from '../src/model/registry.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';

// GY-3788: an account's live check never marks it broken for the check's own sandbox/environment error.
const now = Date.parse('2026-11-24T17:53:00Z');
const iso = (at: number) => new Date(at).toISOString();

const piErofs = "Warning: Invalid settings file /home/vish/.coding_agents/pi-a/settings.json: EROFS: read-only file system, mkdir '/home/vish/.coding_agents/pi-a/settings.json.lock'";
const agyScratchFail = "the smoke test's scratch home /tmp/mainworks-agy-smoke-agy failed, not the account's login: E1124 09:53:53.068568 111 file_watcher.go:194] skipping empty or temporary file";
const missingAlias = 'missing model alias "glm" in launch configuration';
const claudeWeekly = "You've hit your weekly limit, resets Nov 28, 9pm (America/Los_Angeles)";

async function makeFleet(): Promise<AgentRegistry> {
  process.env[hostAccountsVariable] = await temporaryDirectory('check-env-fault-host');
  const pi = structuredClone(proposedRuntimes.find(entry => entry.name === 'pi')!);
  const agy = structuredClone(proposedRuntimes.find(entry => entry.name === 'agy') ?? { ...pi, name: 'agy', launch: { ...pi.launch, kind: 'agy', homeVariable: 'AGY_CONFIG_DIR' } });
  agy.launch.kind = 'agy';
  const claude = structuredClone(proposedRuntimes.find(entry => entry.name === 'claude')!);

  const accounts = [];
  for (const [name, runtime] of [['pi-a', 'pi'], ['agy-a', 'agy'], ['claude-a', 'claude']] as const) {
    const home = await temporaryDirectory(`check-env-fault-${name}`);
    await writeFile(join(home, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: `key-${name}` } }));
    await writeFile(join(home, 'settings.json'), JSON.stringify({ defaultProvider: 'zai', defaultModel: 'glm-5.4' }));
    await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `token-${name}`, refreshToken: 'r', expiresAt: now + 86_400_000 } }));
    accounts.push({ name, runtime, model: 'fixture', credential: { host: 'host', home } });
  }
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [pi, agy, claude],
    models: [{ name: 'fixture', id: 'zai/glm-5.4' }],
    accounts,
    roles: [{ name: 'worker', accounts: ['pi-a', 'agy-a', 'claude-a'], concurrency: 1 }],
    reason: 'GY-3788 fixture',
  }, { actor: 'operator', at: iso(now - 86_400_000) }).registry;
}

const runtimeOf = (registry: AgentRegistry, account: FleetAccount) => registry.runtimes.find(runtime => runtime.name === account.runtime)!;

test('integration:account-check-environment-fault — EROFS on Pi settings.json.lock, agy scratch home failure, and missing model alias leave accounts eligible and record attention once; real provider limit still marks exhausted', async () => {
  const registry = await makeFleet();

  // Seed pi-a as logged-in and previously available, agy-a as logged-in unknown, claude-a as available.
  const pi = registry.accounts.find(a => a.name === 'pi-a')!;
  const agy = registry.accounts.find(a => a.name === 'agy-a')!;
  const claude = registry.accounts.find(a => a.name === 'claude-a')!;
  foldObservation(pi, { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: iso(now - 3_600_000) }, { actor: 'host', at: iso(now - 3_600_000) });
  foldObservation(agy, { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: null }, { actor: 'host', at: iso(now - 3_600_000) });

  // 1. Pi check fails with EROFS on settings.json.lock -> stays available & eligible, fault recorded once.
  const piObs1 = await observeAccount(pi, runtimeOf(registry, pi), {
    now: () => now, cacheMs: 0, quota: false, opencodeAuth: null, opencodeModels: null,
    smoke: async () => ({ ok: false, error: piErofs }),
  }, registry.accounts, 'zai/glm-5.4');
  assert.notEqual(piObs1.quota.state, 'broken', 'Pi EROFS must not mark account broken');
  assert.equal(piObs1.quota.state, 'available', 'Pi keeps its prior quota mark');
  assert.ok(piObs1.quota.fault, 'environment fault is recorded on observation');
  assert.equal(foldObservation(pi, piObs1.quota, { actor: 'host', at: iso(now) }), true, 'first fault is recorded');
  assert.equal(foldObservation(pi, piObs1.quota, { actor: 'host', at: iso(now + 1000) }), false, 'identical repeat fault is not recorded again');
  assert.equal(pi.quota.state, 'available');
  assert.equal(pi.quota.loggedIn, true);

  // 2. agy check fails with scratch home error -> stays eligible, fault recorded once.
  const agyObs = await observeAccount(agy, runtimeOf(registry, agy), {
    now: () => now, cacheMs: 0, quota: false, opencodeAuth: null, opencodeModels: null,
    smoke: async () => ({ ok: false, error: agyScratchFail }),
  }, registry.accounts, 'zai/glm-5.4');
  assert.notEqual(agyObs.quota.state, 'broken', 'agy scratch home failure must not mark account broken');
  assert.equal(agyObs.quota.state, 'unknown', 'agy keeps its prior quota mark');
  assert.ok(agyObs.quota.fault, 'agy scratch fault is recorded');
  assert.equal(foldObservation(agy, agyObs.quota, { actor: 'host', at: iso(now) }), true);
  assert.equal(foldObservation(agy, agyObs.quota, { actor: 'host', at: iso(now + 1000) }), false);

  // 3. Missing model alias in launch -> leaves quota unchanged, records fault.
  const aliasQuota = await checkAccountLive(claude, runtimeOf(registry, claude), {
    now: () => now,
    smoke: async () => ({ ok: false, error: missingAlias }),
  }, 'zai/glm-5.4');
  assert.notEqual(aliasQuota.state, 'broken', 'missing model alias must not mark account broken');
  assert.ok(aliasQuota.fault, 'missing model alias is recorded as fault');

  // 4. Real provider limit sentence still marks claude-a exhausted with that sentence.
  const limitQuota = await checkAccountLive(claude, runtimeOf(registry, claude), {
    now: () => now + 31 * 60_000,
    smoke: async () => ({ ok: false, error: claudeWeekly }),
  }, 'claude-opus-5');
  assert.equal(limitQuota.state, 'exhausted', 'real provider limit still marks exhausted');
  assert.equal(limitQuota.reason, claudeWeekly, 'real provider limit keeps the provider sentence');
  assert.equal(limitQuota.fault ?? null, null, 'real provider limit is not an environment fault');
  foldObservation(claude, limitQuota, { actor: 'host', at: iso(now + 31 * 60_000) });

  // Verify fleetView and attention: pi-a and agy-a are eligible, each fault appears once as attention.
  const view = fleetView(registry, now);
  const piView = view.accounts.find(a => a.name === 'pi-a')!;
  const agyView = view.accounts.find(a => a.name === 'agy-a')!;
  const claudeView = view.accounts.find(a => a.name === 'claude-a')!;
  assert.equal(piView.eligible, true, 'pi-a stays eligible');
  assert.equal(piView.quota, 'available');
  assert.ok(piView.fault, 'pi-a exposes check fault in fleetView');
  assert.equal(agyView.eligible, true, 'agy-a stays eligible');
  assert.ok(agyView.fault, 'agy-a exposes check fault in fleetView');
  assert.equal(claudeView.eligible, false, 'claude-a is held on real provider limit');
  assert.equal(claudeView.quota, 'exhausted');
  assert.equal(claudeView.reason, claudeWeekly);

  assert.ok(view.attention.some(line => line.startsWith('pi-a:')), 'fleetView attention names pi-a once');
  assert.ok(view.attention.some(line => line.startsWith('agy-a:')), 'fleetView attention names agy-a once');

  const { checkFaultAttention } = await import('../src/cli/master-status.js');
  const attention = checkFaultAttention(view);
  assert.equal(attention.length, 2, 'one attention entry per faulted account');
  assert.ok(attention.some(item => item.subject === 'account pi-a'), 'pi-a attention present');
  assert.ok(attention.some(item => item.subject === 'account agy-a'), 'agy-a attention present');
});

test('integration:account-check-environment-fault — Pi live check gets a writable home for settings.json.lock when the account home is read-only', async () => {
  const root = await temporaryDirectory('pi-ro-home-check');
  const roHome = join(root, 'pi-a');
  const bin = join(root, 'bin');
  await mkdir(roHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(roHome, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'fixture-key' } }));
  await writeFile(join(roHome, 'settings.json'), JSON.stringify({ defaultProvider: 'zai', defaultModel: 'glm-5.4' }));

  // Stub Pi binary that creates settings.json.lock inside PI_CODING_AGENT_DIR (just like real Pi does) and checks auth.json is readable.
  const stubPi = join(bin, 'pi.cjs');
  await writeFile(stubPi, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.PI_CODING_AGENT_DIR;
if (!dir || !fs.existsSync(path.join(dir, 'auth.json'))) {
  console.error('No API key found for zai');
  process.exit(1);
}
const lock = path.join(dir, 'settings.json.lock');
try {
  fs.mkdirSync(lock);
  fs.rmdirSync(lock);
} catch (err) {
  console.error(\`Warning: Invalid settings file \${path.join(dir, 'settings.json')}: \${err.code}: read-only file system, mkdir '\${lock}'\`);
  process.exit(1);
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], model: 'glm-5.4' } }));
`);
  await chmod(stubPi, 0o700);

  // Make the account home read-only (0o500).
  await chmod(roHome, 0o500);
  try {
    const pi = structuredClone(proposedRuntimes.find(entry => entry.name === 'pi')!);
    const result = await smokeRegistryAccount({
      name: 'pi-a',
      kind: 'pi',
      home: roHome,
      fleet: { runtime: 'pi', contract: pi.launch, model: 'glm', modelId: 'zai/glm-5.4', session: 'smoke', reason: 'live account check' },
    }, { command: stubPi, timeoutMs: 10_000 });
    assert.equal(result.ok, true, `Pi check should succeed with a writable home for settings.json.lock, got: ${result.error}`);
  } finally {
    await chmod(roHome, 0o700);
  }
});
