import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAccountLive, selectFleetSession, type FleetClient } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, fleetView, foldObservations, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';
import { wrongModelAttention } from '../src/cli/master-status.js';
import { AccountAvailability } from '../web/pages/workers.js';
import type { MasterConfig } from '../src/master/profiles.js';

// GY-3596: an OpenCode account registered for a Z.AI model whose live request answered on the free
// fallback (OpenCode's banner `build · big-pickle`) is broken, shown with both models, and skipped.
const saved = process.env[hostAccountsVariable];
after(() => { if (saved === undefined) delete process.env[hostAccountsVariable]; else process.env[hostAccountsVariable] = saved; });

test('e2e:wrong-model-is-caught — a live check on another model marks the account faulty and keeps it from the next launch', async () => {
  const scratch = await temporaryDirectory('wrong-model');
  process.env[hostAccountsVariable] = join(scratch, 'host-records');
  const home = join(scratch, 'opencode-a');
  await mkdir(home);
  const registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'opencode'), models: [{ name: 'glm', id: 'zai-coding-plan/glm-5.3' }],
    accounts: [{ name: 'opencode-a', runtime: 'opencode', model: 'glm', plan: 'zai', credential: { host: 'host', home } }],
    roles: [{ name: 'worker', accounts: ['opencode-a'], concurrency: 1 }], reason: 'Workers on OpenCode',
  }, { actor: 'operator', at: new Date().toISOString() }).registry as AgentRegistry;
  const account = registry.accounts[0]!, runtime = registry.runtimes[0]!;

  // The live check's own smoke decides: OpenCode answered, on big-pickle, so the smoke's banner path
  // (GY-3592) returns the banner as its error — the check still names both models. The launcher stands
  // in for the runtime binary; everything above it is the production path.
  const launcher = join(home, 'launcher.cjs');
  await writeFile(launcher, "#!/usr/bin/env node\nconsole.log('> build · big-pickle');\nconsole.log('OK');\n", { mode: 0o700 });
  const quota = await checkAccountLive(account, runtime, { smoke: target => smokeRegistryAccount(target, { command: launcher, timeoutMs: 10_000 }) }, 'zai-coding-plan/glm-5.3');
  assert.equal(quota.state, 'broken');
  assert.equal(quota.reason, 'ran on big-pickle, not zai-coding-plan/glm-5.3');
  foldObservations(registry, { host: 'host', observations: [{ account: 'opencode-a', quota }] }, { actor: 'coordinator', at: new Date().toISOString() });

  // The Accounts page shows it faulty, naming both models.
  const view = fleetView(registry, Date.now(), 'host');
  const page = renderToStaticMarkup(createElement(AccountAvailability, { accounts: view.accounts, now: Date.now() }));
  assert.match(page, /data-availability-row="opencode-a" data-state="broken"/);
  assert.match(page, /big-pickle/);
  assert.match(page, /zai-coding-plan\/glm-5\.3/);

  // Master status attention carries one line for it.
  assert.deepEqual(wrongModelAttention(view).map(line => line.text), ['opencode-a ran on big-pickle, not zai-coding-plan/glm-5.3; it takes no new session']);

  // The next launch is not offered it.
  let offered: string | null = null;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    select: async request => {
      foldObservations(registry, request, { actor: 'coordinator', at: new Date().toISOString() });
      const choice = chooseSession(registry, request, Date.now());
      offered = choice.account?.name ?? null;
      return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
    },
    end: async () => {},
  } as FleetClient;
  const config = { hostId: 'host', url: 'https://graphyard.example', credentialFile: join(scratch, 'credential'), repository: 'owner/project' } as MasterConfig;
  await assert.rejects(selectFleetSession(config, 'worker', { name: 'worker' }, { registry: client, quota: false, opencodeAuth: null, opencodeModels: null }), /opencode-a is broken: it ran on big-pickle, not zai-coding-plan\/glm-5\.3/);
  assert.equal(offered, null);
});
