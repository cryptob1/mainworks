import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import { runCaretaker } from '../src/master/caretaker.js';
import { caretakerPrompt } from '../src/master/caretaker-prompt.js';
import { checkAccountLive } from '../src/fleet.js';
import { hostAccountsVariable, recordHostAccountCheck } from '../src/host-accounts.js';
import { parseProbeFailure } from '../src/model/account-quota.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes } from '../src/model/registry.js';
import type { Principal } from '../src/model.js';
import { listen } from './helpers/http-server.js';
import { apiOk } from './helpers/api.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
// With NODE_COMPILE_CACHE set the launcher loads the built CLI in its own process instead of starting a second node.
const compileCache = { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache') };
// The held account's last host check: selection reads it instead of launching the real runtime binary.
const heldCheck = (home: string) => recordHostAccountCheck(home, {
  key: null,
  at: new Date().toISOString(),
  nextCheck: new Date(Date.now() + 30 * 60_000).toISOString(),
  quota: { loggedIn: true, state: 'exhausted', usage: [], resetsAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'held', since: new Date().toISOString() },
});

const stores: Store[] = [];
const servers: (() => Promise<void>)[] = [];
after(async () => { for (const stop of servers) await stop(); for (const store of stores) await store.close(); });

async function startFixtureControlPlane(label: string) {
  const operator: Principal = { id: 'care-operator', role: 'admin', sessionKind: 'human' };
  const coordinator: Principal = { id: 'care-loop', role: 'coordinator', sessionKind: 'ai' };
  const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `care-${principal.id}-${'x'.repeat(32)}` }));
  const token = (actor: Principal) => credentials.find(entry => entry.id === actor.id)!.token;
  const store = await withDatabase(label);
  stores.push(store);
  await store.init();
  const { url, close } = await listen(server(new Engine(store, 7200, 'owner/caretaker'), credentials));
  servers.push(close);
  const ok = (bearer: string, path: string, body?: unknown) => apiOk(url, bearer, path, { body });
  const credDir = await temporaryDirectory(`${label}-creds`);
  const credentialFile = join(credDir, 'coordinator.token');
  await writeFile(credentialFile, `${token(coordinator)}\n`, { mode: 0o600 });
  const cfg: MasterConfig = masterConfigSchema.parse({
    version: 1, url, credentialFile, cliPath: launcher,
    repository: 'owner/caretaker', baseBranch: 'main', githubAppId: 1234, hostId: 'care-host',
    masterAgentName: 'graphyard-master-care', workers: [],
  });
  return { url, cfg, operator, coordinator, token, ok };
}

test('integration:caretaker-account-probe — caretaker probes a held account outside its sandbox and codex stdin banner is never the reason', async () => {
  // AC-2: codex's 'Reading additional input from stdin...' banner is never recorded as the reason.
  const now = Date.parse('2026-11-24T16:00:00Z');
  const limitSentence = "You've hit your usage limit. Try again at 5:00 PM.";
  const bannerThenLimit = parseProbeFailure(`Reading additional input from stdin...\n${limitSentence}\n`, now);
  assert.equal(bannerThenLimit.reason, limitSentence);

  const limitThenBanner = parseProbeFailure(`${limitSentence}\nReading additional input from stdin...\n`, now);
  assert.equal(limitThenBanner.reason, limitSentence, 'a trailing stdin banner must not hide the provider error line');

  const bannerThenJson = parseProbeFailure('Reading additional input from stdin...\n{"type":"thread.started","thread_id":"t1"}\n', now);
  assert.notEqual(bannerThenJson.reason, 'Reading additional input from stdin...', 'banner alone with non-error JSON never becomes the reason');

  const bannerThenLimitThenBanner = parseProbeFailure(`Reading additional input from stdin...\n${limitSentence}\n--------\nReading additional input from stdin...\n`, now);
  assert.equal(bannerThenLimitThenBanner.reason, limitSentence);

  process.env[hostAccountsVariable] = await temporaryDirectory('caretaker-probe-host-accounts');
  const codexHome = await temporaryDirectory('caretaker-probe-codex');
  const codexRuntime = structuredClone(proposedRuntimes.find(entry => entry.name === 'codex')!);
  const codexRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [codexRuntime],
    models: [{ name: 'codex-fixture', id: null }],
    accounts: [{ name: 'codex-a', runtime: 'codex', model: 'codex-fixture', credential: { host: 'care-host', home: codexHome } }],
    roles: [{ name: 'worker', accounts: ['codex-a'], concurrency: 1 }],
    reason: 'GY-3783 codex fixture',
  }, { actor: 'operator', at: new Date(now - 60_000).toISOString() }).registry;
  const checkedCodex = await checkAccountLive(codexRegistry.accounts[0]!, codexRegistry.runtimes[0]!, {
    now: () => now,
    smoke: async () => ({ ok: false, error: `Reading additional input from stdin...\n${limitSentence}\nReading additional input from stdin...` }),
  });
  assert.equal(checkedCodex.state, 'exhausted');
  assert.equal(checkedCodex.reason, limitSentence);

  // AC-1: caretaker session obtains the live probe result (and provider sentence) without reading the held account's credentials.
  const { cfg, operator, token, ok } = await startFixtureControlPlane('caretaker-probe-int');
  const homesRoot = await temporaryDirectory('caretaker-probe-homes');
  const caretakerHome = join(homesRoot, 'claude-care');
  const heldHome = join(homesRoot, 'codex-held');
  await mkdir(caretakerHome, { recursive: true });
  await mkdir(heldHome, { recursive: true });
  await writeFile(join(caretakerHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }), { mode: 0o600 });
  recordHostAccountCheck(caretakerHome, {
    key: null,
    at: new Date().toISOString(),
    nextCheck: new Date(Date.now() + 30 * 60_000).toISOString(),
    quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date().toISOString() },
  });
  await writeFile(join(heldHome, 'auth.json'), JSON.stringify({ secret: 'do-not-leak' }), { mode: 0o600 });

  await ok(token(operator), 'agent-registry/apply', {
    runtimes: [
      proposedRuntimes.find(runtime => runtime.name === 'claude'),
      proposedRuntimes.find(runtime => runtime.name === 'codex'),
    ],
    models: [{ name: 'opus', id: 'claude-opus-5' }, { name: 'codex-m', id: 'gpt-5.3-codex' }],
    accounts: [
      { name: 'claude-care', runtime: 'claude', model: 'opus', credential: { host: 'care-host', home: caretakerHome } },
      { name: 'codex-held', runtime: 'codex', model: 'codex-m', credential: { host: 'care-host', home: heldHome } },
    ],
    roles: [
      { name: 'caretaker', accounts: ['claude-care'], concurrency: 1 },
      { name: 'worker', accounts: ['codex-held'], concurrency: 1 },
    ],
    reason: 'GY-3783 fixture',
  });
  await ok(token(operator), 'agent-registry/accounts/codex-held/quota', {
    quota: { state: 'exhausted', resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    reason: 'Reading additional input from stdin...',
  });
  heldCheck(heldHome);

  const workDir = await temporaryDirectory('caretaker-probe-repo');
  const probedHomes: (string | null)[] = [];
  let probeResult: any = null;
  let unauthStatus = 0;
  let seenEnv: Record<string, string> = {};

  const outcome = await runCaretaker(workDir, cfg, {
    smoke: async (account) => {
      probedHomes.push(account.home ?? null);
      return { ok: false, error: `Reading additional input from stdin...\n${limitSentence}\nReading additional input from stdin...` };
    },
    headless: async (_command, _args, options) => {
      seenEnv = options.env;
      const probeUrl = options.env.GRAPHYARD_CARETAKER_PROBE_URL;
      assert.ok(probeUrl, 'caretaker session receives GRAPHYARD_CARETAKER_PROBE_URL');
      const unauth = await fetch(`${probeUrl}/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'codex-held' }),
      });
      unauthStatus = unauth.status;
      const { stdout } = await exec(process.execPath, [launcher, 'caretaker', 'registry', 'account', 'probe', 'codex-held'], {
        cwd: workDir,
        env: { ...process.env, ...compileCache, ...options.env, GRAPHYARD_TOKEN: undefined, GRAPHYARD_REQUEST_ID: undefined },
      });
      probeResult = JSON.parse(stdout);
      return 'done';
    },
  });

  assert.ok(!('skipped' in outcome), `caretaker should not be skipped: ${JSON.stringify(outcome)}`);

  assert.equal(unauthStatus, 401, 'unauthenticated probe requests are rejected');
  assert.deepEqual(probedHomes, [heldHome], 'the loop ran the live probe with the held account\'s own login home');
  assert.equal(probeResult.account, 'codex-held');
  assert.equal(probeResult.state, 'exhausted');
  assert.equal(probeResult.reason, limitSentence, 'caretaker receives the provider sentence, never the stdin banner');
  assert.ok(!JSON.stringify(probeResult).includes('do-not-leak'), 'probe output never leaks account credentials');
  assert.equal(seenEnv.CODEX_HOME, undefined, 'held account home is not exposed in the caretaker environment');
  assert.equal(seenEnv.CLAUDE_CONFIG_DIR, caretakerHome, 'caretaker only receives its own runtime login home');
});

test('e2e:caretaker-account-probe — caretaker probes a held fixture account, receives its provider sentence, and step 1 names the command', async () => {
  // AC-3: caretaker prompt's step 1 names `caretaker registry account probe NAME`.
  const prompt = caretakerPrompt('mainworks');
  const step1 = prompt.split('\n').find(line => line.startsWith('(1) ')) ?? '';
  assert.match(step1, /caretaker registry account probe NAME/, 'step 1 names the probe command');
  assert.doesNotMatch(step1, /one minimal prompt run with that account's own login/, 'step 1 no longer tells the caretaker to launch runtimes directly');

  process.env[hostAccountsVariable] = await temporaryDirectory('caretaker-probe-e2e-host-accounts');
  const { cfg, operator, token, ok } = await startFixtureControlPlane('caretaker-probe-e2e');
  const homesRoot = await temporaryDirectory('caretaker-probe-e2e-homes');
  const caretakerHome = join(homesRoot, 'claude-care');
  const heldHome = join(homesRoot, 'claude-held');
  await mkdir(caretakerHome, { recursive: true });
  await mkdir(heldHome, { recursive: true });
  await writeFile(join(caretakerHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }), { mode: 0o600 });
  recordHostAccountCheck(caretakerHome, {
    key: null,
    at: new Date().toISOString(),
    nextCheck: new Date(Date.now() + 30 * 60_000).toISOString(),
    quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date().toISOString() },
  });

  await ok(token(operator), 'agent-registry/apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')],
    models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [
      { name: 'claude-care', runtime: 'claude', model: 'opus', credential: { host: 'care-host', home: caretakerHome } },
      { name: 'claude-held', runtime: 'claude', model: 'opus', credential: { host: 'care-host', home: heldHome } },
    ],
    roles: [
      { name: 'caretaker', accounts: ['claude-care'], concurrency: 1 },
      { name: 'worker', accounts: ['claude-held'], concurrency: 1 },
    ],
    reason: 'GY-3783 e2e fixture',
  });
  await ok(token(operator), 'agent-registry/accounts/claude-held/quota', {
    quota: { state: 'exhausted', resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    reason: 'Stale hold',
  });
  heldCheck(heldHome);

  const providerSentence = "You've hit your weekly limit · resets Nov 28, 10pm (UTC)";
  const workDir = await temporaryDirectory('caretaker-probe-e2e-repo');
  const reportFile = join(workDir, 'report.txt');
  let probed: any = null;

  const outcome = await runCaretaker(workDir, cfg, {
    smoke: async () => ({ ok: false, error: JSON.stringify({ type: 'result', is_error: true, api_error: 'usage_limit_reached', result: providerSentence }) }),
    headless: async (_command, _args, options) => {
      const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, [launcher, ...args], {
        cwd: workDir,
        env: { ...process.env, ...compileCache, ...options.env, GRAPHYARD_TOKEN: undefined, GRAPHYARD_REQUEST_ID: undefined },
      })).stdout);
      probed = await cli('caretaker', 'registry', 'account', 'probe', 'claude-held');
      await cli('caretaker', 'registry', 'account', 'quota', 'claude-held', probed.state, '--reason', probed.reason);
      await writeFile(reportFile, `fixed: claude-held probed and marked ${probed.state} ("${probed.reason}")\n`);
      await cli('caretaker', 'report', reportFile);
      return 'done';
    },
  });

  assert.equal(probed.reason, providerSentence);
  assert.equal(probed.state, 'exhausted');
  assert.ok('result' in outcome && outcome.result.includes(providerSentence), `outcome carries the provider sentence: ${JSON.stringify(outcome)}`);
  const updated = (await ok(token(operator), 'agent-registry')).accounts.find((entry: any) => entry.name === 'claude-held');
  assert.equal(updated.reason, providerSentence, 'held account reason updated to the provider sentence');
});
