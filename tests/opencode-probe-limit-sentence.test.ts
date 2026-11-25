import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAccountLive } from '../src/fleet.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes } from '../src/model/registry.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';

// GY-3819: OpenCode ends a spent Z.AI account's run with "Model unavailable"; the provider's limit
// sentence is elsewhere in the run's error output: an earlier event, or the log --print-logs adds.
const modelId = 'zai-coding-plan/glm-5.3';
const now = Date.parse('2026-11-25T04:00:00Z');
const sentence = 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-28 12:49:15';
const unavailable = JSON.stringify({ type: 'error', error: { type: 'provider.no-route', message: `Model unavailable: ${modelId}` } });
const limitEvent = JSON.stringify({ type: 'error', error: { type: 'provider.quota', message: sentence, status: 429, response: { body: JSON.stringify({ error: { code: '1310', message: sentence } }) } } });
const limitLog = `timestamp=2026-11-25T04:00:00.000Z level=ERROR run=ac7afb61 message="Failed to drain Session" cause="AI.Error: ${sentence}\\n    at yfe (chunk.js:3:2991)" role=server`;
const otherLog = 'timestamp=2026-11-25T04:00:00.100Z level=INFO run=ac7afb61 message="watcher stopped" role=server';

/** Probes the account with an OpenCode that prints `stdout`, and `logs` on stderr only when given --print-logs. */
async function probe(stdout: string[], logs: string[], stderr: string[] = []) {
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
process.exitCode = 1;
`, { mode: 0o700 });
  return checkAccountLive(registry.accounts[0]!, registry.runtimes[0]!, { now: () => now, smoke: target => smokeRegistryAccount(target, { command, timeoutMs: 20_000 }) }, modelId);
}

for (const [where, stdout, logs] of [['an earlier error event', [limitEvent, unavailable], []], ['the run\'s log', [unavailable], [limitLog, otherLog]]] as const)
  test(`e2e:opencode-probe-limit-sentence — the limit in ${where} behind "Model unavailable" is exhausted until its reset`, async () => {
    const quota = await probe([...stdout], [...logs]);
    assert.equal(quota.state, 'exhausted', quota.reason ?? undefined);
    assert.equal(quota.reason, sentence);
    // Z.AI names its reset in Beijing time.
    assert.equal(quota.resetsAt, '2026-11-28T04:49:15.000Z');
    assert.equal(quota.session, 'named');
  });

test('e2e:opencode-probe-limit-sentence — a model that is really missing is broken, with logs or without', async () => {
  for (const quota of [await probe([unavailable], [otherLog]), await probe([], [otherLog], [`Model unavailable: ${modelId}`])]) {
    assert.equal(quota.state, 'broken');
    assert.equal(quota.reason, `Model unavailable: ${modelId}`);
    assert.equal(quota.resetsAt, null);
  }
});
