import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAccountLive, type FleetLaunchAccount } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { accountLaunch } from '../src/master/environments.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes } from '../src/model/registry.js';
import { registryHeadlessLaunch, smokeRegistryAccount } from '../src/runner/roles.js';

// GY-3830: OpenCode answers a fresh run from the catalog built into it, which ends at glm-5.3, and
// resolves a newer model only when its config declares it.
const modelId = 'zai-coding-plan/glm-5.4';
const now = Date.parse('2026-11-25T04:00:00Z');
const sentence = 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-28 12:49:15';
const runtime = () => structuredClone(proposedRuntimes.find(entry => entry.name === 'opencode')!);

/** Probes a glm-5.4 account with an OpenCode that resolves its model as 2.2.5 does, then prints `answer`. */
async function probe(answer: unknown) {
  process.env[hostAccountsVariable] = await temporaryDirectory('opencode-catalog-host');
  const home = await temporaryDirectory('opencode-catalog');
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [runtime()], models: [{ name: 'glm-5.4', id: modelId }],
    accounts: [{ name: 'opencode-a', runtime: 'opencode', model: 'glm-5.4', credential: { host: 'host', home } }],
    roles: [{ name: 'worker', accounts: ['opencode-a'], concurrency: 1 }], reason: 'GY-3830 fixture',
  }, { actor: 'operator', at: new Date(now).toISOString() }).registry;
  const command = join(home, 'opencode.cjs');
  await writeFile(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('  --standalone   Private server'); process.exit(0); }
const id = args[args.indexOf('--model') + 1], [provider, model] = id.split('/');
const declared = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}').provider?.[provider]?.models ?? {};
const listed = ['glm-5.2', 'glm-5.3', ...Object.keys(declared)].includes(model);
console.log(JSON.stringify(listed ? ${JSON.stringify(answer)} : { type: 'error', error: { type: 'provider.no-route', message: 'Model unavailable: ' + id } }));
`, { mode: 0o700 });
  return checkAccountLive(registry.accounts[0]!, registry.runtimes[0]!, { now: () => now, smoke: target => smokeRegistryAccount(target, { command, timeoutMs: 20_000 }) }, modelId);
}

test('e2e:opencode-probe-current-model-catalog — a model newer than OpenCode\'s catalog answers its probe', async () => {
  const quota = await probe({ type: 'text', part: { text: 'OK' } });
  assert.equal(quota.state, 'available', quota.reason ?? undefined);
});

test('e2e:opencode-probe-current-model-catalog — an account at its Z.AI limit is exhausted with Z.AI\'s sentence', async () => {
  const quota = await probe({ type: 'error', error: { type: 'provider.quota', message: sentence, status: 429 } });
  assert.equal(quota.state, 'exhausted', quota.reason ?? undefined);
  assert.equal(quota.reason, sentence);
  assert.equal(quota.resetsAt, '2026-11-28T04:49:15.000Z');
});

test('e2e:opencode-probe-current-model-catalog — worker and headless launches declare the model beside the runtime\'s own config', async () => {
  const own = { theme: 'dark', model: 'old', provider: { other: { name: 'x' }, 'zai-coding-plan': { options: { timeout: 1 }, models: { 'glm-5.4': { name: 'own' } } } } };
  const launch = runtime().launch;
  const account = { name: 'opencode-a', kind: 'opencode', home: await temporaryDirectory('opencode-catalog-launch'),
    fleet: { runtime: 'opencode', contract: { ...launch, environment: { OPENCODE_CONFIG_CONTENT: JSON.stringify(own) } }, model: 'glm-5.4', modelId, session: 's', reason: 'r' } } as unknown as FleetLaunchAccount;
  for (const { environment } of [accountLaunch({ approvals: 'auto', agentArgs: [], environment: {} }, account), registryHeadlessLaunch(account)])
    assert.deepEqual(JSON.parse(environment.OPENCODE_CONFIG_CONTENT!), { ...own, model: modelId });
  account.fleet.contract = launch;
  for (const { environment } of [accountLaunch({ approvals: 'auto', agentArgs: [], environment: {} }, account), registryHeadlessLaunch(account)])
    assert.deepEqual(JSON.parse(environment.OPENCODE_CONFIG_CONTENT!).provider, { 'zai-coding-plan': { models: { 'glm-5.4': {} } } });
});
