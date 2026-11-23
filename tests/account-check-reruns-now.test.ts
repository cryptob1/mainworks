import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registryCommand } from '../src/cli/master-registry.js';
import { hostAccountsVariable, recordHostAccountCheck } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3749: after a repair, a Lead confirms it at once rather than waiting out the 30-minute cache.
test('unit:account-check-reruns-now — account check runs the live check now, reports it to the registry and prints one line', async () => {
  process.env[hostAccountsVariable] = await temporaryDirectory('account-check-host');
  const home = await temporaryDirectory('account-check-home'), at = new Date().toISOString();
  const registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [structuredClone(proposedRuntimes.find(entry => entry.name === 'cursor')!)], models: [{ name: 'cursor-default', id: 'auto' }],
    accounts: [{ name: 'cursor-a', runtime: 'cursor', model: 'cursor-default', credential: { host: 'host-1', home } }],
    roles: [{ name: 'reviewer', accounts: ['cursor-a'], concurrency: 1 }], reason: 'GY-3749 fixture',
  }, { actor: 'operator', at }).registry;
  // Checked a minute ago and broken: the cache would hold that answer for 30 minutes.
  const broken = { loggedIn: true, state: 'broken' as const, usage: [], resetsAt: null, reason: 'Workspace Trust Required', since: at };
  recordHostAccountCheck(home, { key: null, at, nextCheck: new Date(Date.now() + 29 * 60_000).toISOString(), quota: broken });
  const observed: any[] = [];
  const api = { read: async () => registry, write: async (path: string, data: any) => { observed.push({ path, data }); return { changed: true }; } };
  let smokes = 0;
  const passed = await registryCommand({ hostId: 'host-1' } as any, ['account', 'check', 'cursor-a'], api, { smoke: async () => { smokes++; return { ok: true, error: null, output: 'OK' }; } });
  assert.equal(smokes, 1, 'the live request ran despite the fresh cached check');
  assert.equal(passed, 'cursor-a passed its live check');
  assert.equal(observed[0].path, 'agent-registry/observe');
  assert.deepEqual([observed[0].data.host, observed[0].data.observations[0].account, observed[0].data.observations[0].quota.state], ['host-1', 'cursor-a', 'available']);
  const out = await registryCommand({ hostId: 'host-1' } as any, ['account', 'check', 'cursor-a'], api, { smoke: async () => ({ ok: false, error: "Authentication required. Please run 'agent login' first." }) });
  assert.match(String(out), /^cursor-a is not logged in: Authentication required/);
  assert.doesNotMatch(String(out), /\n/, 'one line');
});
