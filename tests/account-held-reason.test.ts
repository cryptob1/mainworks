import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAccountLive } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes } from '../src/model/registry.js';

// GY-3591 AC-1: a held account records the provider's own sentence and parsed reset time,
// never raw JSON; non-JSON output falls back to the last non-empty line, at most 160 chars,
// and never containing '{' followed by a quote.
const now = Date.parse('2026-11-21T20:00:00Z');
const claudeSentence = "You've hit your weekly limit · resets Nov 23, 10pm (UTC)";
const claudeJsonFixture = JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 412,
  num_turns: 1,
  api_error: 'usage_limit_reached',
  result: claudeSentence,
  usage: { input_tokens: 0, output_tokens: 0, depth_limit: 0, padding: 'x'.repeat(500) },
});

async function fixtureAccount(runtimeName: string) {
  process.env[hostAccountsVariable] = await temporaryDirectory(`held-reason-host-${runtimeName}`);
  const home = await temporaryDirectory(`held-reason-${runtimeName}`);
  const runtime = structuredClone(proposedRuntimes.find(entry => entry.name === runtimeName)!);
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [runtime],
    models: [{ name: 'fixture', id: null }],
    accounts: [{ name: `${runtimeName}-a`, runtime: runtimeName, model: 'fixture', credential: { host: 'host', home } }],
    roles: [{ name: 'worker', accounts: [`${runtimeName}-a`], concurrency: 1 }],
    reason: 'GY-3591 fixture',
  }, { actor: 'operator', at: new Date(now - 60_000).toISOString() }).registry;
  return { account: registry.accounts[0]!, runtime: registry.runtimes[0]! };
}

test('unit:account-held-reason-is-the-providers-sentence — Claude probe JSON stores result sentence and parsed reset time', async () => {
  const { account, runtime } = await fixtureAccount('claude');
  const quota = await checkAccountLive(account, runtime, {
    now: () => now,
    smoke: async () => ({ ok: false, error: claudeJsonFixture }),
  });
  assert.equal(quota.state, 'exhausted');
  assert.equal(quota.reason, claudeSentence);
  assert.equal(Date.parse(quota.resetsAt!), Date.parse('2026-11-23T22:00:00Z'));
  assert.equal(quota.session, 'named');
});

test('unit:account-held-reason-is-the-providers-sentence — non-JSON output uses the last non-empty line, at most 160 chars, with no JSON fragment', async () => {
  const { account, runtime } = await fixtureAccount('codex');
  const longLine = `Provider temporarily unavailable: ${'retry-soon '.repeat(20)}`;
  const plain = await checkAccountLive(account, runtime, {
    now: () => now,
    smoke: async () => ({ ok: false, error: `Reading additional input from stdin...\n${longLine}\n\n   \n` }),
  });
  assert.ok(plain.reason);
  assert.ok(plain.reason.length <= 160, `expected <= 160 chars, got ${plain.reason.length}`);
  assert.equal(plain.reason, longLine.trim().slice(0, 160).trim());
  assert.doesNotMatch(plain.reason, /\{\s*["']/);

  // Truncated / non-JSON output containing '{"' never leaks '{' followed by a quote.
  const brokenJson = await checkAccountLive(account, runtime, {
    now: () => now,
    smoke: async () => ({ ok: false, error: '":{"depth_limit":0,"is_error":true,"api_error":"usage_limit_reached' }),
  });
  assert.ok(brokenJson.reason);
  assert.ok(brokenJson.reason.length <= 160);
  assert.doesNotMatch(brokenJson.reason, /\{\s*["']/);
});

test('unit:account-held-reason-is-the-providers-sentence — empty output falls back cleanly with no reset time', async () => {
  const { account, runtime } = await fixtureAccount('claude');
  const empty = await checkAccountLive(account, runtime, {
    now: () => now,
    smoke: async () => ({ ok: false, error: '   \n\t  ' }),
  });
  assert.equal(empty.state, 'broken');
  assert.equal(empty.resetsAt, null);
  assert.ok(empty.reason && empty.reason.length > 0 && empty.reason.length <= 160);
  assert.doesNotMatch(empty.reason, /\{\s*["']/);
});
