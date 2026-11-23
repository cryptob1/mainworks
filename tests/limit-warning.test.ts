import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, proposedRuntimes, type AgentRegistry } from '../src/model/registry.js';
import { claudeAccount, codexAccount } from '../src/master/environment-quota.js';
import { parseZaiUsage } from '../src/model/provider-usage.js';
import { accountAllowances, allowanceAttention } from '../src/cli/master-status.js';

// GY-3499: each account's allowance reads as one plain sentence, built from the windows each
// provider really reports, and an account with live sessions past 80% of a window raises one
// status row that clears by itself when the window resets or drops.

const at = '2026-11-21T07:00:00.000Z', now = Date.parse(at), hour = 3_600_000, HOST = 'build-host-1';
const in5h = '2026-11-21T09:20:00.000Z', inWeek = '2026-11-22T05:00:00.000Z';

/** Windows as each provider's own reader yields them, from that provider's response shape. */
async function providerWindows() {
  const home = mkdtempSync(join(tmpdir(), 'limit-warning-'));
  // Claude: the OAuth usage endpoint's five_hour and seven_day.
  mkdirSync(join(home, 'claude')); writeFileSync(join(home, 'claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'token', expiresAt: now + hour } }));
  const fetch = (async () => new Response(JSON.stringify({ five_hour: { utilization: 82, resets_at: in5h }, seven_day: { utilization: 76, resets_at: inWeek } }))) as unknown as typeof globalThis.fetch;
  const claude = (await claudeAccount({ name: 'claude-a', kind: 'claude', home: join(home, 'claude') }, { fetch }, now)).usage;
  // Codex: the rate limits a session writes, primary 300 minutes and secondary 10080 minutes.
  const day = join(home, 'codex', 'sessions', '2026', '11', '21'); mkdirSync(day, { recursive: true });
  writeFileSync(join(home, 'codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'token' } }));
  writeFileSync(join(day, 'rollout.jsonl'), `${JSON.stringify({ payload: { rate_limits: {
    primary: { used_percent: 40, window_minutes: 300, resets_at: Date.parse(in5h) / 1000 },
    secondary: { used_percent: 90, window_minutes: 10080, resets_at: Date.parse(inWeek) / 1000 } } } })}\n`);
  const codex = (await codexAccount({ name: 'codex-a', kind: 'codex', home: join(home, 'codex') }, {})).usage;
  // Z.ai: the quota endpoint's limits, unit 3 five-hour and unit 6 weekly, and the monthly TIME_LIMIT it never counts.
  const zai = parseZaiUsage({ data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 12, nextResetTime: Date.parse(in5h) },
    { type: 'TOKENS_LIMIT', unit: 6, percentage: 30, nextResetTime: Date.parse(inWeek) },
    { type: 'TIME_LIMIT', unit: 5, percentage: 99, nextResetTime: Date.parse(inWeek) }] } }).windows;
  return { claude, codex, zai };
}

/** A fleet of the four accounts, each with the windows given; `busy` names those running a live session. */
function fleet(usage: Record<string, AgentRegistry['accounts'][number]['quota']['usage']>, busy: string[]): AgentRegistry {
  let registry = emptyRegistry();
  const names = Object.keys(usage);
  registry = applyRegistryMutation(registry, 'apply', { runtimes: [proposedRuntimes.find(entry => entry.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: names.map(name => ({ name, runtime: 'claude', model: 'opus', credential: { host: HOST, home: `/agents/${name}` } })),
    roles: [{ name: 'worker', accounts: names, concurrency: 4 }], reason: 'fixture' }, { actor: 'operator', at }).registry;
  for (const account of registry.accounts) account.quota = { ...account.quota, loggedIn: true, state: 'available', usage: usage[account.name]! };
  registry.sessions = busy.map(account => ({ id: `session-${account}`, role: 'worker', account, runtime: 'claude', model: 'opus', host: HOST, work: 'GY-1', principal: null,
    selectedAt: at, selectedBy: 'loop', reason: 'fixture', skipped: [], endedAt: null, endReason: null }));
  return registry;
}

test('integration:limit-warning — each provider\'s windows read as one plain sentence per account, and an account with live sessions past 80% raises one status row that clears on its own', async () => {
  const { claude, codex, zai } = await providerWindows();
  assert.deepEqual(claude.map(entry => entry.window), ['5h', '7d']);
  assert.deepEqual(codex.map(entry => entry.window), ['5h', '7d']);
  assert.deepEqual(zai.map(entry => entry.window), ['5h', '7d']);

  // AC-1: master registry (the fleet view) and master status say one sentence per account, no window codes.
  const registry = fleet({ claude, codex, zai, silent: [] }, ['claude', 'codex', 'silent']);
  const view = fleetView(registry, now, HOST);
  const sentences = Object.fromEntries(view.accounts.map(account => [account.name, account.allowance]));
  assert.deepEqual(sentences, {
    claude: 'about 18% of this 5-hour window left, back at 09:20',
    codex: 'about 10% of this week left, back Sun 22 Nov 05:00',
    zai: 'about 70% of this week left, back Sun 22 Nov 05:00',
    silent: 'allowance not reported',
  });
  for (const sentence of Object.values(sentences)) assert.doesNotMatch(sentence!, /\b(5h|7d)\b/);
  assert.deepEqual(accountAllowances(view, now), ['claude: about 18% of this 5-hour window left, back at 09:20', 'codex: about 10% of this week left, back Sun 22 Nov 05:00',
    'zai: about 70% of this week left, back Sun 22 Nov 05:00', 'silent: allowance not reported']);
  assert.equal(accountAllowances(fleetView(fleet({ spent: [{ window: '7d', percent: 100, resetsAt: inWeek }] }, []), now, HOST), now)[0], 'spent: nothing of this week left, back Sun 22 Nov 05:00');

  // AC-2: one row per account with live sessions and a window at or past 80%; zai is under 80% and silent reports nothing.
  assert.deepEqual(allowanceAttention(view, now), [
    { subject: 'account claude', text: 'claude has used 82% of its 5-hour allowance; it is back at 09:20', next: 'the loop tries other accounts first' },
    { subject: 'account codex', text: 'codex has used 90% of its weekly allowance; it is back Sun 22 Nov 05:00', next: 'the loop tries other accounts first' },
  ]);
  // An account past 80% with no live session raises nothing.
  assert.deepEqual(allowanceAttention(fleetView(fleet({ claude, codex }, []), now, HOST), now), []);
  // The row clears by itself: once the 5-hour window resets claude's tightest live window is its week at 76%.
  const later = Date.parse(in5h) + 60_000;
  assert.deepEqual(allowanceAttention(fleetView(registry, later, HOST), later).map(row => row.subject), ['account codex']);
  // And when a newer reading drops under 80%.
  const dropped = fleet({ claude, codex: codex.map(entry => ({ ...entry, percent: 50 })) }, ['claude', 'codex']);
  assert.deepEqual(allowanceAttention(fleetView(dropped, now, HOST), now).map(row => row.subject), ['account claude']);
});
