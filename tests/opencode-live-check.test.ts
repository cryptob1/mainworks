import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAccountLive } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, foldObservation, proposedRuntimes } from '../src/model/registry.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';
import { accountStatus } from '../web/agent-status.js';

// GY-3592: opencode-b and opencode-c on core were held 'exhausted' by OpenCode's own free-model
// refusal while their Z.AI plan read 1% and 15% used: the live check named no model.
const modelId = 'zai-coding-plan/glm-5.3';
const freeTierRefusal = 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.';
const now = Date.parse('2026-11-21T20:10:00Z');

async function fixture() {
  process.env[hostAccountsVariable] = await temporaryDirectory('opencode-live-check-host');
  const home = await temporaryDirectory('opencode-live-check');
  const runtime = structuredClone(proposedRuntimes.find(entry => entry.name === 'opencode')!);
  runtime.launch.environment = { FIXTURE_SETTING: 'configured' };
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [runtime], models: [{ name: 'glm-5.3', id: modelId }],
    accounts: [{ name: 'opencode-b', runtime: 'opencode', model: 'glm-5.3', credential: { host: 'host', home } }],
    roles: [{ name: 'worker', accounts: ['opencode-b'], concurrency: 1 }], reason: 'GY-3592 fixture',
  }, { actor: 'operator', at: new Date(now - 86_400_000).toISOString() }).registry;
  const account = registry.accounts[0]!;
  const check = (smoke: Parameters<typeof checkAccountLive>[2] & {}) => checkAccountLive(account, registry.runtimes[0]!, { now: () => now, ...smoke }, modelId);
  return { home, registry, account, check };
}

test('unit:opencode-live-check-names-the-accounts-model — the check launches OpenCode with the account\'s model id and the runtime\'s configured environment', async () => {
  const { home, check } = await fixture();
  const launcher = join(home, 'launcher.cjs');
  await writeFile(launcher, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(home, 'call.json'))}, JSON.stringify({ args: process.argv.slice(2), home: process.env.XDG_DATA_HOME, setting: process.env.FIXTURE_SETTING }));\nconsole.log('OK');\n`, { mode: 0o700 });
  const quota = await check({ smoke: target => smokeRegistryAccount(target, { command: launcher, timeoutMs: 5000 }) });
  assert.equal(quota.state, 'available');
  const call = JSON.parse(await readFile(join(home, 'call.json'), 'utf8')) as { args: string[]; home: string; setting: string };
  assert.equal(call.args[call.args.indexOf('--model') + 1], modelId, `the command names the account's model: ${call.args.join(' ')}`);
  assert.equal(call.args.filter(arg => arg === '--model').length, 1);
  assert.equal(call.home, home, 'on the account\'s own login');
  assert.equal(call.setting, 'configured', 'with the runtime\'s configured environment');
});

test('unit:opencode-free-tier-refusal-is-not-exhaustion — the free-tier refusal breaks an account whose model has a provider; it is never a limit', async () => {
  const { check } = await fixture();
  const refused = await check({ smoke: async () => ({ ok: false, error: freeTierRefusal }) });
  assert.equal(refused.state, 'broken');
  assert.equal(refused.resetsAt, null);
  assert.match(refused.reason ?? '', /plan model zai-coding-plan\/glm-5\.3 was not used/);
  const unavailable = await check({ smoke: async () => ({ ok: false, error: `Model unavailable: ${modelId}` }) });
  assert.equal(unavailable.state, 'broken');
  assert.equal(unavailable.reason, `Model unavailable: ${modelId}`);
});

test('unit:opencode-free-tier-refusal-is-not-exhaustion — OpenCode printing Model unavailable fails the check with that text', async () => {
  const { home, check } = await fixture();
  const launcher = join(home, 'launcher.cjs');
  await writeFile(launcher, `#!/usr/bin/env node\nconsole.error('Model unavailable: ${modelId}');\nprocess.exit(1);\n`, { mode: 0o700 });
  const quota = await check({ smoke: target => smokeRegistryAccount(target, { command: launcher, timeoutMs: 5000 }) });
  assert.equal(quota.state, 'broken');
  assert.equal(quota.reason, `Model unavailable: ${modelId}`);
});

test('unit:opencode-free-tier-refusal-is-not-exhaustion — a run whose banner names another model than the account\'s is broken, though it answered', async () => {
  const { home, check } = await fixture();
  const launcher = join(home, 'launcher.cjs');
  const banner = (model: string) => writeFile(launcher, `#!/usr/bin/env node\nconsole.log('> build · ${model}');\nconsole.log('OK');\n`, { mode: 0o700 });
  const smoke = { smoke: (target: Parameters<typeof smokeRegistryAccount>[0]) => smokeRegistryAccount(target, { command: launcher, timeoutMs: 5000 }) };
  await banner('big-pickle');
  const wrong = await check(smoke);
  assert.equal(wrong.state, 'broken');
  assert.equal(wrong.resetsAt, null);
  assert.equal(wrong.reason, `ran on big-pickle, not ${modelId}`);
  await banner('glm-5.3');
  assert.equal((await check(smoke)).state, 'available', 'the account\'s own model in the banner passes');
});

test('e2e:opencode-free-tier-is-not-a-limit — the Accounts page never shows a Z.AI account as out of allowance for OpenCode\'s free-tier refusal', async () => {
  const { registry, account, check } = await fixture();
  foldObservation(account, await check({ smoke: async () => ({ ok: false, error: freeTierRefusal }) }), { actor: 'host', at: new Date(now).toISOString() });
  const fleet = fleetView(registry, now), shown = fleet.accounts[0]!;
  assert.equal(shown.quota, 'broken');
  const status = accountStatus(shown, fleet, now);
  assert.notEqual(status.chip, 'spent', status.reason);
  const { AccountCard } = await import('../web/pages/fleet.js');
  const { availabilityLine } = await import('../web/pages/workers.js');
  const page = renderToStaticMarkup(createElement(AccountCard, { account: shown, now })) + availabilityLine(shown, now).text;
  assert.match(page, /Quota: broken/);
  assert.match(page, /opencode-b · broken · .*plan model zai-coding-plan\/glm-5\.3 was not used/);
  assert.doesNotMatch(page, /exhausted|held until|limit reached|Resets: unknown/i);
});
