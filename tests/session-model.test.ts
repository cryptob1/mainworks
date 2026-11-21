import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportedModel } from '../src/master/runtimes.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, fleetView, proposedRuntimes, recordSessionModel, wrongModel, type AgentRegistry } from '../src/model/registry.js';
import { wrongModelAttention } from '../src/cli/master-status.js';
import { usageRows } from '../src/usage-capture.js';

// GY-3596: one recorded output per runtime, as each prints it headless.
const claudeJson = JSON.stringify({ type: 'result', subtype: 'success', result: 'OK', modelUsage: {
  'claude-haiku-4-5-20251001': { inputTokens: 300, outputTokens: 12 }, 'claude-opus-4-5-20251101': { inputTokens: 9, outputTokens: 400 } } });
const codexRun = ['OpenAI Codex v0.58.0 (research preview)', '--------', 'workdir: /work', 'model: gpt-5.1-codex', 'provider: openai', 'approval: never', '--------',
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })].join('\n');
const piRun = [JSON.stringify({ type: 'agent_start' }), JSON.stringify({ type: 'message_end', message: { role: 'user', content: [] } }),
  JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'zai', model: 'glm-4.6', content: [{ type: 'text', text: 'OK' }] } })].join('\n');

test('unit:session-model-is-read-per-runtime — each adapter reads the model its runtime reported, or null', () => {
  assert.equal(reportedModel('opencode', '\n> build · big-pickle\n\nOK\n'), 'big-pickle');
  assert.equal(reportedModel('opencode', 'build · glm-5.3\nOK'), 'glm-5.3');
  assert.equal(reportedModel('claude', claudeJson), 'claude-opus-4-5-20251101', 'the main model, not a side request’s');
  assert.equal(reportedModel('claude', JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' })), 'claude-sonnet-4-5');
  assert.equal(reportedModel('codex', codexRun), 'gpt-5.1-codex');
  assert.equal(reportedModel('pi', piRun), 'glm-4.6');
  for (const kind of ['opencode', 'claude', 'codex', 'pi']) assert.equal(reportedModel(kind, 'OK\n'), null, `${kind}: output naming no model`);
  assert.equal(reportedModel('cursor', claudeJson), null, 'a runtime with no reader names none');
});

function registry(id: string | null) {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'opencode'), models: [{ name: 'glm', id }],
    accounts: [{ name: 'opencode-a', runtime: 'opencode', model: 'glm', credential: { host: 'host', home: '/homes/opencode-a' } }],
    roles: [{ name: 'worker', accounts: ['opencode-a'], concurrency: 1 }], reason: 'fixture',
  }, { actor: 'operator', at: new Date().toISOString() }).registry as AgentRegistry;
}

test('unit:wrong-model-marks-the-account-broken — a session on another model marks its account broken, naming both', () => {
  const at = new Date().toISOString(), context = { actor: 'coordinator', at };
  assert.equal(wrongModel('glm-5.3', 'zai-coding-plan/glm-5.3'), null, 'a provider prefix is no mismatch');
  assert.equal(wrongModel('claude-opus-4-5-20251101', 'opus[1m]'), null, 'an alias is no mismatch');
  assert.equal(wrongModel('big-pickle', 'zai-coding-plan/glm-5.3'), 'ran on big-pickle, not zai-coding-plan/glm-5.3');

  // Match: nothing changes.
  const matched = registry('zai-coding-plan/glm-5.3');
  assert.equal(recordSessionModel(matched, 'opencode-a', 'glm-5.3', context), false);
  assert.equal(matched.accounts[0]!.quota.state, 'unknown');
  // No report, and no model id: nothing changes.
  assert.equal(recordSessionModel(matched, 'opencode-a', null, context), false);
  const unnamed = registry(null);
  assert.equal(recordSessionModel(unnamed, 'opencode-a', 'big-pickle', context), false);
  assert.equal(unnamed.accounts[0]!.quota.state, 'unknown');

  // Mismatch: broken, named, not selectable, one attention line.
  const wrong = registry('zai-coding-plan/glm-5.3');
  assert.equal(recordSessionModel(wrong, 'opencode-a', 'big-pickle', context), true);
  assert.equal(wrong.accounts[0]!.quota.state, 'broken');
  assert.equal(wrong.accounts[0]!.quota.reason, 'ran on big-pickle, not zai-coding-plan/glm-5.3');
  const view = fleetView(wrong, Date.now(), 'host');
  assert.equal(view.accounts[0]!.eligible, false);
  assert.match(view.accounts[0]!.ineligible ?? '', /opencode-a is broken: it ran on big-pickle, not zai-coding-plan\/glm-5\.3/);
  const attention = wrongModelAttention(view);
  assert.equal(attention.length, 1);
  assert.match(attention[0]!.text, /opencode-a ran on big-pickle, not zai-coding-plan\/glm-5\.3/);
  assert.deepEqual(wrongModelAttention(fleetView(matched, Date.now(), 'host')), []);

  // A finished session's rows carry the model its runtime reported, so the control plane can compare.
  const rows = usageRows({ id: 's1', work: 'GY-1', role: 'reviewer', account: 'opencode-a', runtime: 'opencode', at }, '> build · big-pickle\nOK');
  assert.equal(rows[0]!.ran, 'big-pickle');
});
