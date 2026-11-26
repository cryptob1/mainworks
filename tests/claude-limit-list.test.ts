import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { useTestStore } from './helpers/test-store.js';
import { checkAgentEnvironment } from '../src/master.js';
import { observeAccount } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, foldObservation, proposedRuntimes, utcClock, type AgentRegistry, type FleetView } from '../src/model/registry.js';
import { registryCommand } from '../src/cli/master-registry.js';
import type { Principal } from '../src/model.js';

// GY-3497: Claude's own limit list — the answer's limits[] (session, weekly, each model-scoped
// weekly) and spend — is read as the account's windows and its extra-usage line. A window of that
// list at the ceiling holds the account (as in usage-ceiling-holds); an answer without limits keeps
// the five_hour/seven_day metering read, which never holds (GY-3555).
const HOST = 'claude-limit-host';
const hour = 3_600_000;
/** An instant ahead of now, rounded to the minute so the sentence it names is exact. */
const minute = (ms: number) => new Date(Math.ceil((Date.now() + ms) / 60_000) * 60_000).toISOString();
const claudeHome = async (name: string, token: string) => {
  const home = await temporaryDirectory(`claude-${name}`);
  await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'r', expiresAt: Date.now() + 86_400_000 } }), { mode: 0o600 });
  return home;
};
/** The provider's usage endpoint answering one body per access token, recording every request. */
const endpointOf = (byToken: Record<string, unknown>) => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace('Bearer ', '');
    return new Response(JSON.stringify(byToken[token] ?? {}), { status: 200 });
  };
  return { fetch: fetcher, calls };
};
const runtime = () => proposedRuntimes.find(entry => entry.name === 'claude')!;

test('integration:claude-limit-list — limits[] is read as one window per entry (session, weekly, each model-scoped weekly named by its model), any one at the ceiling holds with its window named, five_hour and seven_day stand when limits is absent, and spend shows as one plain line with no request that changes it', async () => {
  const root = await temporaryDirectory('claude-limit-list');
  process.env[hostAccountsVariable] = await temporaryDirectory('host-records', root);
  const sessionReset = minute(4 * hour), weeklyReset = minute(3 * 24 * hour), fableReset = minute(26 * hour);
  const limitsAnswer = { limits: [
    { kind: 'session', percent: 12, resets_at: sessionReset },
    { kind: 'weekly_all', percent: 40, resets_at: weeklyReset },
    { kind: 'weekly_scoped', scope: { model: 'Fable' }, percent: 97, resets_at: fableReset },
  ], spend: { enabled: true, used: 321, limit: 1000 } };
  const { fetch, calls } = endpointOf({ 'token-a': limitsAnswer });
  const home = await claudeHome('a', 'token-a');

  // The probe reads the answer's own list: every window named in words, the scoped one by its model.
  const held = await checkAgentEnvironment({ name: 'claude-a', kind: 'claude', home }, { fetch, cacheMs: 0, ceilingPercent: 95 });
  assert.deepEqual(held.usage, [
    { window: 'session', percent: 12, resetsAt: sessionReset, limitList: true },
    { window: 'weekly', percent: 40, resetsAt: weeklyReset, limitList: true },
    { window: 'Fable weekly', percent: 97, resetsAt: fableReset, limitList: true }]);
  assert.equal(held.quota, 'exhausted', 'the scoped window sits at the ceiling');
  assert.equal(held.healthy, false);
  assert.equal(held.reason, `claude-a quota is exhausted (Fable weekly window at 97% until ${fableReset}; ceiling 95%)`);
  assert.equal(held.spend, 'extra usage on: $3.21 of $10.00 used');

  // Any window of the list at the ceiling holds, the session one too, with its window named.
  const sessionSpent = await checkAgentEnvironment({ name: 'claude-a', kind: 'claude', home }, { fetch: endpointOf({ 'token-a': { limits: [
    { kind: 'session', percent: 96, resets_at: sessionReset }, { kind: 'weekly_all', percent: 40, resets_at: weeklyReset }] } }).fetch, cacheMs: 0, ceilingPercent: 95 });
  assert.equal(sessionSpent.quota, 'exhausted');
  assert.equal(sessionSpent.reason, `claude-a quota is exhausted (session window at 96% until ${sessionReset}; ceiling 95%)`);

  // An answer with no limits keeps the metering windows: five_hour and seven_day as before.
  const metered = await checkAgentEnvironment({ name: 'claude-a', kind: 'claude', home }, { fetch: endpointOf({ 'token-a': { five_hour: { utilization: 30, resets_at: sessionReset }, seven_day: { utilization: 100, resets_at: weeklyReset } } }).fetch, cacheMs: 0, ceilingPercent: 95 });
  assert.deepEqual(metered.usage.map(entry => [entry.window, entry.percent]), [['5h', 30], ['7d', 100]]);
  assert.equal(metered.spend, undefined, 'no spend line without the answer naming one');

  // Through the registry: the list's window holds past the account's own passing live request, with
  // one plain sentence; the metering answer never holds (GY-3555); spend reaches the account view.
  const oldHome = await claudeHome('old', 'token-old');
  const probe = endpointOf({ 'token-a': limitsAnswer, 'token-old': { five_hour: { utilization: 30, resets_at: sessionReset }, seven_day: { utilization: 100, resets_at: weeklyReset } } });
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [runtime()], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', plan: 'fable-plan', credential: { host: HOST, home } },
      { name: 'claude-old', runtime: 'claude', model: 'opus', plan: 'old-plan', credential: { host: HOST, home: oldHome } }],
    roles: [{ name: 'worker', accounts: ['claude-a', 'claude-old'], concurrency: 2 }], reason: 'fixture',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
  const observe = async (name: string) => {
    const account = registry.accounts.find(entry => entry.name === name)!;
    const { quota } = await observeAccount(account, registry.runtimes[0], { fetch: probe.fetch, cacheMs: 0, ceilingPercent: 95,
      smoke: async () => ({ ok: true, error: null }), opencodeAuth: null, opencodeModels: null }, registry.accounts, 'claude-opus-5');
    return { account, quota };
  };
  const fableAccount = registry.accounts.find(entry => entry.name === 'claude-a')!;
  foldObservation(fableAccount, (await observe('claude-a')).quota, { actor: HOST, at: new Date().toISOString() });
  foldObservation(registry.accounts.find(entry => entry.name === 'claude-old')!, (await observe('claude-old')).quota, { actor: HOST, at: new Date().toISOString() });
  const view = fleetView(registry, Date.now(), HOST);
  const fable = view.accounts.find(account => account.name === 'claude-a')!;
  assert.equal(fable.quota, 'exhausted', 'the limit list holds the account past its passing live request');
  assert.equal(fable.eligible, false);
  assert.equal(fable.evidence, `Fable weekly allowance 97% used, back ${utcClock(fableReset)}`);
  assert.equal(fable.ineligible, `claude-a quota is exhausted: Fable weekly allowance 97% used, back ${utcClock(fableReset)}`);
  assert.equal(fable.spend, 'extra usage on: $3.21 of $10.00 used');
  const metering = view.accounts.find(account => account.name === 'claude-old')!;
  assert.equal(metering.quota, 'available', 'a metering read still never holds (GY-3555)');
  assert.equal(metering.eligible, true);
  assert.equal(metering.spend, null);

  // A re-read within the live-check window — the cached branch — keeps both the hold and the line.
  const again = (await observe('claude-a')).quota;
  assert.equal(again.state, 'exhausted');
  assert.equal(again.reason, `Fable weekly allowance 97% used, back ${utcClock(fableReset)}`);
  assert.equal(again.spend, 'extra usage on: $3.21 of $10.00 used');

  // Reading spend changes nothing: every request the probe made was the one usage GET.
  for (const call of [...calls, ...probe.calls]) assert.equal(call, 'GET https://api.anthropic.com/api/oauth/usage', call);
});

// ---------------------------------------------------------------------------
// e2e:claude-limit-list — the real control plane and `master registry`.
// ---------------------------------------------------------------------------
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `${principal.id}-${'x'.repeat(32)}` }));
let url: string;
const call = async (principal: Principal, path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${credentials.find(entry => entry.id === principal.id)!.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
};

useTestStore('claude-limit-list', { leaseSeconds: 7200, repository: 'owner/claude-limit-list', credentials: credentials }, ctx => { ({ url } = ctx); });

test('e2e:claude-limit-list — a stub usage answer with a weekly 40% and a Fable weekly 97% holds the account with the reason \'Fable weekly allowance 97% used, back <time>\', and master registry shows the extra-usage line', async () => {
  const root = await temporaryDirectory('claude-limit-e2e');
  process.env[hostAccountsVariable] = await temporaryDirectory('host-records', root);
  const fableReset = minute(26 * hour), weeklyReset = minute(3 * 24 * hour);
  const home = await claudeHome('fable', 'token-fable');
  const endpoint = endpointOf({ 'token-fable': { limits: [
    { kind: 'session', percent: 12, resets_at: minute(4 * hour) },
    { kind: 'weekly_all', percent: 40, resets_at: weeklyReset },
    { kind: 'weekly_scoped', scope: { model: 'Fable' }, percent: 97, resets_at: fableReset },
  ], spend: { enabled: true, used: 321, limit: 1000 } } });
  await call(operator, 'agent-registry/apply', { runtimes: [runtime()], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-fable', runtime: 'claude', model: 'opus', plan: 'fable-plan', credential: { host: HOST, home } }],
    roles: [{ name: 'worker', accounts: ['claude-fable'], concurrency: 2 }], reason: 'claude limit list e2e' });

  // Probed as the loop does, with the account's own live request passing: the list still holds it.
  const document = await call(coordinator, 'agent-registry/document') as AgentRegistry;
  const account = document.accounts[0];
  const quota = (await observeAccount(account, document.runtimes[0], { fetch: endpoint.fetch, cacheMs: 0,
    smoke: async () => ({ ok: true, error: null }), opencodeAuth: null, opencodeModels: null }, document.accounts, 'claude-opus-5')).quota;
  await call(coordinator, 'agent-registry/observe', { host: HOST, observations: [{ account: account.name, quota }] });

  // `mainworks master registry` as the operator runs it.
  const view = await registryCommand({ hostId: HOST }, [], { read: path => call(coordinator, path), write: path => { throw new Error(`no write expected: ${path}`); } }) as FleetView;
  const held = view.accounts.find(entry => entry.name === 'claude-fable')!;
  assert.equal(held.quota, 'exhausted');
  assert.equal(held.eligible, false);
  assert.equal(held.ineligible, `claude-fable quota is exhausted: Fable weekly allowance 97% used, back ${utcClock(fableReset)}`);
  assert.equal(held.spend, 'extra usage on: $3.21 of $10.00 used');
  assert.equal(view.roles.find(role => role.role === 'worker')!.next, null, 'no role launches on it');
  for (const request of endpoint.calls) assert.equal(request, 'GET https://api.anthropic.com/api/oauth/usage', request);
});
