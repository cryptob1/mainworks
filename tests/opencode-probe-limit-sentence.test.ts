import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { checkAccountLive } from '../src/fleet.js';
import { hostAccountsVariable, recordHostAccountCheck } from '../src/host-accounts.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import { runCaretaker } from '../src/master/caretaker.js';
import type { Principal } from '../src/model.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes } from '../src/model/registry.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { listen } from './helpers/http-server.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const stores: Store[] = [];
const servers: (() => Promise<void>)[] = [];
after(async () => { for (const stop of servers) await stop(); for (const store of stores) await store.close(); });

// GY-3819 / GY-3823: OpenCode ends a spent Z.AI account's run with "Model unavailable" (often on
// exit 0); the provider's limit sentence is elsewhere in the run's error output: an earlier event,
// or the stderr log --print-logs adds.
const modelId = 'zai-coding-plan/glm-5.3';
const now = Date.parse('2026-11-25T04:00:00Z');
const sentence = 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-28 12:49:15';
const unavailable = JSON.stringify({ type: 'error', error: { type: 'provider.no-route', message: `Model unavailable: ${modelId}` } });
const limitEvent = JSON.stringify({ type: 'error', error: { type: 'provider.quota', message: sentence, status: 429, response: { body: JSON.stringify({ error: { code: '1310', message: sentence } }) } } });
const limitLog = `timestamp=2026-11-25T04:00:00.000Z level=ERROR run=ac7afb61 message="Failed to drain Session" cause="AI.Error: ${sentence}\\n    at yfe (chunk.js:3:2991)" role=server`;
const otherLog = 'timestamp=2026-11-25T04:00:00.100Z level=INFO run=ac7afb61 message="watcher stopped" role=server';

/** Probes the account with an OpenCode that prints `stdout`, and `logs` on stderr only when given --print-logs. */
async function probe(stdout: string[], logs: string[], stderr: string[] = [], exitCode = 1) {
  process.env[hostAccountsVariable] = await temporaryDirectory('opencode-probe-limit-host');
  const home = await temporaryDirectory('opencode-probe-limit');
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [structuredClone(proposedRuntimes.find(entry => entry.name === 'opencode')!)], models: [{ name: 'glm-5.3', id: modelId }],
    accounts: [{ name: 'opencode-b', runtime: 'opencode', model: 'glm-5.3', credential: { host: 'host', home } }],
    roles: [{ name: 'worker', accounts: ['opencode-b'], concurrency: 1 }], reason: 'GY-3819 fixture',
  }, { actor: 'operator', at: new Date(now).toISOString() }).registry;
  const command = join(home, 'opencode.cjs');
  await writeFile(command, `#!/usr/bin/env node
if (process.argv.includes('--help')) { console.log('  --standalone   Private server\\n  --print-logs   Print logs to stderr'); process.exit(0); }
for (const line of ${JSON.stringify(stdout)}) console.log(line);
for (const line of ${JSON.stringify(stderr)}) console.error(line);
if (process.argv.includes('--print-logs')) for (const line of ${JSON.stringify(logs)}) console.error(line);
process.exitCode = ${exitCode};
`, { mode: 0o700 });
  return checkAccountLive(registry.accounts[0]!, registry.runtimes[0]!, { now: () => now, smoke: target => smokeRegistryAccount(target, { command, timeoutMs: 20_000 }) }, modelId);
}

for (const [where, stdout, logs, exitCode] of [
  ['an earlier error event', [limitEvent, unavailable], [], 1],
  ['the run\'s log (exit 1)', [unavailable], [limitLog, otherLog], 1],
  ['the run\'s log (exit 0)', [unavailable], [limitLog, otherLog], 0],
] as const)
  test(`e2e:opencode-probe-limit-sentence — the limit in ${where} behind "Model unavailable" is exhausted until its reset`, async () => {
    const quota = await probe([...stdout], [...logs], [], exitCode);
    assert.equal(quota.state, 'exhausted', quota.reason ?? undefined);
    assert.equal(quota.reason, sentence);
    // Z.AI names its reset in Beijing time.
    assert.equal(quota.resetsAt, '2026-11-28T04:49:15.000Z');
    assert.equal(quota.session, 'named');
  });

test('e2e:opencode-probe-limit-sentence — a model that is really missing is broken, with logs or without', async () => {
  for (const quota of [await probe([unavailable], [otherLog]), await probe([unavailable], [otherLog], [], 0), await probe([], [otherLog], [`Model unavailable: ${modelId}`])]) {
    assert.equal(quota.state, 'broken');
    assert.equal(quota.reason, `Model unavailable: ${modelId}`);
    assert.equal(quota.resetsAt, null);
  }
});

test('e2e:opencode-probe-limit-sentence — caretaker registry account probe records Z.AI exhaustion on exit 0 with --print-logs and keeps a missing model broken', async () => {
  process.env[hostAccountsVariable] = await temporaryDirectory('opencode-caretaker-probe-host');
  const operator: Principal = { id: 'oc-operator', role: 'admin', sessionKind: 'human' };
  const coordinator: Principal = { id: 'oc-loop', role: 'coordinator', sessionKind: 'ai' };
  const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `oc-${principal.id}-${'x'.repeat(32)}` }));
  const token = (actor: Principal) => credentials.find(entry => entry.id === actor.id)!.token;
  const store = await withDatabase('opencode-caretaker-probe');
  stores.push(store);
  await store.init();
  const { url, close } = await listen(server(new Engine(store, 7200, 'owner/opencode-probe'), credentials));
  servers.push(close);
  const ok = async (bearer: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}/api/${path}`, body === undefined
      ? { headers: { Authorization: `Bearer ${bearer}` } }
      : { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    const parsed = await response.json() as any;
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(parsed)}`);
    return parsed;
  };

  const credDir = await temporaryDirectory('opencode-caretaker-creds');
  const credentialFile = join(credDir, 'coordinator.token');
  await writeFile(credentialFile, `${token(coordinator)}\n`, { mode: 0o600 });
  const cfg: MasterConfig = masterConfigSchema.parse({
    version: 1, url, credentialFile, cliPath: launcher,
    repository: 'owner/opencode-probe', baseBranch: 'main', githubAppId: 1234, hostId: 'oc-host',
    masterAgentName: 'graphyard-master-oc', workers: [],
  });

  const homesRoot = await temporaryDirectory('opencode-caretaker-homes');
  const caretakerHome = join(homesRoot, 'claude-care');
  const spentHome = join(homesRoot, 'opencode-a');
  const missingHome = join(homesRoot, 'opencode-missing');
  const fakeBin = join(homesRoot, 'bin');
  for (const dir of [caretakerHome, spentHome, missingHome, fakeBin]) await mkdir(dir, { recursive: true });
  await writeFile(join(caretakerHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }), { mode: 0o600 });
  recordHostAccountCheck(caretakerHome, {
    key: null,
    at: new Date().toISOString(),
    nextCheck: new Date(Date.now() + 30 * 60_000).toISOString(),
    quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date().toISOString() },
  });

  // Reset time 3 days ahead in Beijing time (UTC+8), formatted as Z.AI prints it.
  const resetUtcMs = Math.floor((Date.now() + 3 * 86_400_000) / 1000) * 1000;
  const resetIso = new Date(resetUtcMs).toISOString();
  const resetBeijing = new Date(resetUtcMs + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
  const liveSentence = `Weekly/Monthly Limit Exhausted. Your limit will reset at ${resetBeijing}`;
  const model54 = 'zai-coding-plan/glm-5.4';
  const unavailable54 = JSON.stringify({ type: 'error', error: { type: 'provider.no-route', message: `Model unavailable: ${model54}` } });

  // Fixture `opencode` binary: --print-logs is listed on top-level `--help` (and must appear before
  // the prompt), runtime pins glm-5.3 in OPENCODE_CONFIG_CONTENT while accounts name glm-5.4, and
  // the run exits 0 with JSON "Model unavailable" on stdout and logs on stderr.
  await writeFile(join(fakeBin, 'opencode'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) {
  if (args[0] === 'run') console.log('  --standalone   Private server');
  else console.log('  --print-logs   Print logs to stderr');
  process.exit(0);
}
const promptIdx = args.findIndex(a => a.includes('Reply with'));
const logsIdx = args.indexOf('--print-logs');
const hasLogsBeforePrompt = logsIdx >= 0 && (promptIdx < 0 || logsIdx < promptIdx);
const cfg = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {};
if (cfg.model && cfg.model !== ${JSON.stringify(model54)}) {
  console.error('unexpected OPENCODE_CONFIG_CONTENT model: ' + cfg.model);
  process.exit(1);
}
console.log(${JSON.stringify(unavailable54)});
if (hasLogsBeforePrompt) {
  if (process.env.XDG_DATA_HOME === ${JSON.stringify(spentHome)}) {
    console.error('ERROR 2026-11-25T05:01:00 +210ms service=session.processor error={"name":"APIError","data":{"message":' + JSON.stringify(${JSON.stringify(liveSentence)}) + '}}');
  }
  console.error('INFO  2026-11-25T05:01:01 +1ms service=bus watcher stopped');
}
process.exit(0);
`, { mode: 0o700 });

  const opencodeRuntime = structuredClone(proposedRuntimes.find(runtime => runtime.name === 'opencode')!);
  opencodeRuntime.launch.environment = {
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'zai-coding-plan/glm-5.3' }),
  };

  await ok(token(operator), 'agent-registry/apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!, opencodeRuntime],
    models: [{ name: 'opus', id: 'claude-opus-5' }, { name: 'glm-5.4', id: model54 }],
    accounts: [
      { name: 'claude-care', runtime: 'claude', model: 'opus', credential: { host: 'oc-host', home: caretakerHome } },
      { name: 'opencode-a', runtime: 'opencode', model: 'glm-5.4', credential: { host: 'oc-host', home: spentHome } },
      { name: 'opencode-missing', runtime: 'opencode', model: 'glm-5.4', credential: { host: 'oc-host', home: missingHome } },
    ],
    roles: [
      { name: 'caretaker', accounts: ['claude-care'], concurrency: 1 },
      { name: 'worker', accounts: ['opencode-a', 'opencode-missing'], concurrency: 1 },
    ],
    reason: 'GY-3823 caretaker probe fixture',
  });

  const workDir = await temporaryDirectory('opencode-caretaker-repo');
  let spentProbe: any = null;
  let missingProbe: any = null;

  const outcome = await runCaretaker(workDir, cfg, {
    headless: async (_command, _args, options) => {
      const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, [launcher, ...args], {
        cwd: workDir,
        env: { ...process.env, ...options.env, GRAPHYARD_TOKEN: undefined, GRAPHYARD_REQUEST_ID: undefined },
      })).stdout);
      spentProbe = await cli('caretaker', 'registry', 'account', 'probe', 'opencode-a');
      missingProbe = await cli('caretaker', 'registry', 'account', 'probe', 'opencode-missing');
      return 'done';
    },
  });

  assert.ok(!('skipped' in outcome), `caretaker should not be skipped: ${JSON.stringify(outcome)}`);
  assert.equal(spentProbe.state, 'exhausted', JSON.stringify(spentProbe));
  assert.equal(spentProbe.reason, liveSentence);
  assert.equal(spentProbe.resetsAt, resetIso);

  assert.equal(missingProbe.state, 'broken', JSON.stringify(missingProbe));
  assert.equal(missingProbe.reason, `Model unavailable: ${model54}`);
  assert.equal(missingProbe.resetsAt, null);
});
