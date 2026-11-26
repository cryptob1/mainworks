import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import type { Principal } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { runCaretaker } from '../src/master/caretaker.js';
import { fleetRoleHealth } from '../src/fleet.js';
import { hostAccountsVariable, recordHostAccountCheck } from '../src/host-accounts.js';
import { parseProbeFailure } from '../src/model/account-quota.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';
import { shellQuote } from '../src/shell-quote.js';
import { listen } from './helpers/http-server.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

const stores: Store[] = [];
const servers: (() => Promise<void>)[] = [];
after(async () => { for (const stop of servers) await stop(); for (const store of stores) await store.close(); });

function writeStubAgy(binDir: string, name: string, mode: 'ok-noisy' | 'fail-noisy', providerError = '') {
  const file = join(binDir, `${name}.cjs`);
  writeFileSync(file, `#!/usr/bin/env node
const noisy = () => {
  for (let i = 0; i < 80; i++) {
    console.error(\`E1125 03:48:00.\${String(i).padStart(6, '0')} 111 file_watcher.go:194] skipping empty or temp file /tmp/scratch/file-\${i}\`);
  }
};
if (${JSON.stringify(mode)} === 'ok-noisy') {
  console.log('OK');
  noisy();
  process.exit(0);
}
console.error(${JSON.stringify(providerError)});
noisy();
process.exit(1);
`);
  chmodSync(file, 0o755);
  return file;
}

function writeStubPi(binDir: string, name: string, mode: 'ok' | 'fail', expectedKey: string, providerError = '') {
  const file = join(binDir, `${name}.cjs`);
  writeFileSync(file, `#!/usr/bin/env node
if (${JSON.stringify(mode)} === 'fail') {
  console.error(${JSON.stringify(providerError)});
  process.exit(1);
}
if (process.env.ZAI_API_KEY !== ${JSON.stringify(expectedKey)}) {
  console.error('No API key found for zai');
  process.exit(1);
}
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }], model: 'glm-5.4' } }));
`);
  chmodSync(file, 0o755);
  return file;
}

test('e2e:scheduled-account-check-matches-probe — scheduled check matches caretaker probe for noisy agy and OpenCode-backed Pi, and records real failures with the provider sentence', async () => {
  const base = await temporaryDirectory('e2e-sched-check-probe');
  process.env[hostAccountsVariable] = join(base, 'host-accounts');

  const bin = join(base, 'bin');
  const caretakerHome = join(base, 'claude-care');
  const agyHome = join(base, 'agy');
  const opencodeHome = join(base, 'opencode-a');
  const piHome = join(base, 'pi-a');
  const workDir = join(base, 'repo');
  for (const dir of [bin, caretakerHome, agyHome, join(opencodeHome, 'opencode'), piHome, workDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Caretaker account login (pre-cached passing so runCaretaker launches cleanly).
  // Seed agy and pi-a with a cached broken check so runCaretaker's selectAccount doesn't spawn real binaries;
  // caretaker registry account probe then probes them live via deps.smoke.
  writeFileSync(join(caretakerHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }), { mode: 0o600 });
  const now = Date.now();
  recordHostAccountCheck(caretakerHome, {
    key: null,
    at: new Date(now).toISOString(),
    nextCheck: new Date(now + 30 * 60_000).toISOString(),
    quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date(now).toISOString() },
  });
  for (const home of [agyHome, piHome]) {
    recordHostAccountCheck(home, {
      key: null,
      at: new Date(now - 60_000).toISOString(),
      nextCheck: new Date(now + 29 * 60_000).toISOString(),
      quota: { loggedIn: true, state: 'broken', usage: [], resetsAt: null, reason: 'stale broken mark', since: new Date(now - 60_000).toISOString() },
    });
  }

  // agy account login + Pi account whose Z.AI key lives in opencode-a's OpenCode auth file
  // (Pi's auth.json command points to opencode-a/auth.json while OpenCode stores it in opencode-a/opencode/auth.json).
  writeFileSync(join(agyHome, 'antigravity-oauth-token'), 'oauth-token-fixture', { mode: 0o600 });
  const zaiKey = 'zai-key-from-opencode-a';
  writeFileSync(join(opencodeHome, 'opencode', 'auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: zaiKey } }), { mode: 0o600 });
  writeFileSync(join(piHome, 'auth.json'), JSON.stringify({
    zai: { type: 'api_key', key: `!jq -r '."zai-coding-plan".key' ${shellQuote(join(opencodeHome, 'auth.json'))}` },
  }), { mode: 0o600 });

  const agyOk = writeStubAgy(bin, 'agy-ok', 'ok-noisy');
  const agyProviderError = 'Provider rejected credentials: invalid OAuth token';
  const agyFail = writeStubAgy(bin, 'agy-fail', 'fail-noisy', agyProviderError);
  const piOk = writeStubPi(bin, 'pi-ok', 'ok', zaiKey);
  const piProviderError = 'Z.AI API returned 401: invalid API key';
  const piFail = writeStubPi(bin, 'pi-fail', 'fail', zaiKey, piProviderError);

  // Unit check: parseProbeFailure ignores agy file_watcher glog lines when a real error is present.
  const parsedFail = parseProbeFailure(
    `${agyProviderError}\nE1125 03:48:00.000001 111 file_watcher.go:194] skipping empty or temp file /tmp/x\n`,
    now,
  );
  assert.equal(parsedFail.reason, agyProviderError, 'file_watcher stderr log line must not replace the provider sentence');

  // Spin up a fixture control plane.
  const operator: Principal = { id: 'sched-operator', role: 'admin', sessionKind: 'human' };
  const coordinator: Principal = { id: 'sched-loop', role: 'coordinator', sessionKind: 'ai' };
  const credentials = [operator, coordinator].map(p => ({ ...p, token: `sched-${p.id}-${'x'.repeat(32)}` }));
  const token = (actor: Principal) => credentials.find(entry => entry.id === actor.id)!.token;
  const store = await withDatabase('e2e-sched-check-probe');
  stores.push(store);
  await store.init();
  const { url, close } = await listen(server(new Engine(store, 7200, 'owner/sched-probe'), credentials));
  servers.push(close);

  const apiCall = async (bearer: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, body === undefined
      ? { headers: { Authorization: `Bearer ${bearer}` } }
      : { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    const parsed = await response.json() as any;
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(parsed)}`);
    return parsed;
  };

  const claudeRuntime = structuredClone(proposedRuntimes.find(r => r.name === 'claude')!);
  const piRuntime = structuredClone(proposedRuntimes.find(r => r.name === 'pi')!);
  const agyRuntime = structuredClone(proposedRuntimes.find(r => r.name === 'agy') ?? {
    name: 'agy',
    description: 'Antigravity CLI',
    launch: { kind: 'agy', args: [], environment: {}, homeVariable: 'AGY_CONFIG_DIR', modelFlag: '--model', login: null, loginFile: null },
  });
  agyRuntime.launch.kind = 'agy';

  await apiCall(token(operator), 'agent-registry/apply', {
    runtimes: [claudeRuntime, agyRuntime, piRuntime],
    models: [
      { name: 'opus', id: 'claude-opus-5' },
      { name: 'agy-default', id: 'gemini-3-pro' },
      { name: 'pi-glm-5.4', id: 'zai/glm-5.4' },
    ],
    accounts: [
      { name: 'claude-care', runtime: 'claude', model: 'opus', credential: { host: 'sched-host', home: caretakerHome } },
      { name: 'agy', runtime: 'agy', model: 'agy-default', credential: { host: 'sched-host', home: agyHome } },
      { name: 'pi-a', runtime: 'pi', model: 'pi-glm-5.4', credential: { host: 'sched-host', home: piHome } },
    ],
    roles: [
      { name: 'caretaker', accounts: ['claude-care'], concurrency: 1 },
      { name: 'worker', accounts: ['agy', 'pi-a'], concurrency: 2 },
    ],
    reason: 'GY-3878 fixture',
  });

  const credFile = join(base, 'coordinator.token');
  writeFileSync(credFile, `${token(coordinator)}\n`, { mode: 0o600 });
  const cfg: MasterConfig = masterConfigSchema.parse({
    version: 1,
    url,
    credentialFile: credFile,
    cliPath: launcher,
    repository: 'owner/sched-probe',
    baseBranch: 'main',
    githubAppId: 1234,
    hostId: 'sched-host',
    masterAgentName: 'mainworks-master-sched',
    workers: [],
  });

  const smokePass = (target: Parameters<typeof smokeRegistryAccount>[0]) =>
    smokeRegistryAccount(target, { command: target.kind === 'agy' ? agyOk : piOk, timeoutMs: 10_000 });

  // 1. Run `caretaker registry account probe` for agy and pi-a.
  let agyProbed: any = null;
  let piProbed: any = null;
  const outcome = await runCaretaker(workDir, cfg, {
    smoke: smokePass,
    headless: async (_command, _args, options) => {
      const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, [launcher, ...args], {
        cwd: workDir,
        env: { ...process.env, ...options.env, GRAPHYARD_TOKEN: undefined, GRAPHYARD_REQUEST_ID: undefined },
      })).stdout);
      agyProbed = await cli('caretaker', 'registry', 'account', 'probe', 'agy');
      piProbed = await cli('caretaker', 'registry', 'account', 'probe', 'pi-a');
      await cli('caretaker', 'registry', 'account', 'quota', 'agy', agyProbed.state, '--reason', agyProbed.line);
      await cli('caretaker', 'registry', 'account', 'quota', 'pi-a', piProbed.state, '--reason', piProbed.line);
      return 'done';
    },
  });
  assert.ok(!('skipped' in outcome), `caretaker should not be skipped: ${JSON.stringify(outcome)}`);
  assert.equal(agyProbed.state, 'available', `caretaker probe should pass noisy agy: ${JSON.stringify(agyProbed)}`);
  assert.equal(piProbed.state, 'available', `caretaker probe should pass OpenCode-backed pi-a: ${JSON.stringify(piProbed)}`);

  // 2. Run the loop's scheduled account check (`fleetRoleHealth`, 4 minutes later, after the operator quota signal).
  const fourMinutesLater = now + 4 * 60_000;
  await fleetRoleHealth(cfg, 'worker', {
    now: () => fourMinutesLater,
    smoke: smokePass,
    quota: false,
    opencodeAuth: null,
    opencodeModels: null,
  });

  const afterPass = await apiCall(token(operator), 'agent-registry?host=sched-host');
  const agyAfterPass = afterPass.accounts.find((entry: any) => entry.name === 'agy');
  const piAfterPass = afterPass.accounts.find((entry: any) => entry.name === 'pi-a');
  assert.equal(agyAfterPass.quota, 'available', `scheduled check should record agy available: ${JSON.stringify(agyAfterPass)}`);
  assert.equal(piAfterPass.quota, 'available', `scheduled check should record pi-a available: ${JSON.stringify(piAfterPass)}`);

  // 3. When a live request really fails (35 minutes later, when the next scheduled check is due),
  //    both accounts are recorded broken with the provider's sentence (never file_watcher log lines).
  const thirtyFiveMinutesLater = fourMinutesLater + 35 * 60_000;
  const smokeFail = (target: Parameters<typeof smokeRegistryAccount>[0]) =>
    smokeRegistryAccount(target, { command: target.kind === 'agy' ? agyFail : piFail, timeoutMs: 10_000 });

  await fleetRoleHealth(cfg, 'worker', {
    now: () => thirtyFiveMinutesLater,
    smoke: smokeFail,
    quota: false,
    opencodeAuth: null,
    opencodeModels: null,
  });

  const afterFail = await apiCall(token(operator), 'agent-registry?host=sched-host');
  const agyAfterFail = afterFail.accounts.find((entry: any) => entry.name === 'agy');
  const piAfterFail = afterFail.accounts.find((entry: any) => entry.name === 'pi-a');
  assert.equal(agyAfterFail.quota, 'broken', `really failing agy should be broken: ${JSON.stringify(agyAfterFail)}`);
  assert.equal(agyAfterFail.reason, agyProviderError, `failing agy keeps the provider sentence, not file_watcher stderr: ${JSON.stringify(agyAfterFail)}`);
  assert.doesNotMatch(agyAfterFail.reason ?? '', /file_watcher\.go/, 'file_watcher stderr is never the failure sentence');
  assert.equal(piAfterFail.quota, 'broken', `really failing pi-a should be broken: ${JSON.stringify(piAfterFail)}`);
  assert.equal(piAfterFail.reason, piProviderError, `failing pi-a keeps the provider sentence: ${JSON.stringify(piAfterFail)}`);
});
