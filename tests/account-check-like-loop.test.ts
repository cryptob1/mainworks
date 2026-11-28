import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountCheckDiagnostics } from '../src/cli/account-diagnostics.js';
import { registryCommand } from '../src/cli/master-registry.js';
import { commands } from '../src/cli/index.js';
import { createContext } from '../src/cli/context.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes, fleetView } from '../src/model/registry.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withEnv } from './helpers/env.js';

test('integration:account-check-like-loop — global key override, shell mismatch and one health row per account', async () => {
  const root = await temporaryDirectory('account-check-like-loop');
  const home = join(root, 'account'), config = join(root, 'config');
  await mkdir(home);
  await mkdir(join(root, '.git'));
  await mkdir(join(config, 'opencode'), { recursive: true });
  const ownFile = join(home, 'key'), globalFile = join(config, 'opencode', 'opencode.json');
  await writeFile(ownFile, 'account-secret', { mode: 0o600 });
  await writeFile(globalFile, JSON.stringify({ provider: { zai: { options: { apiKey: 'global-secret' } } } }));
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [structuredClone(proposedRuntimes.find(r => r.name === 'opencode')!)],
    models: [{ name: 'glm', id: 'zai/glm-5' }],
    accounts: ['ready', 'disabled', 'spent'].map(name => ({ name, runtime: 'opencode', model: 'glm', enabled: name !== 'disabled', credential: { host: 'host', home, key: { file: 'key', variable: 'ZAI_API_KEY' } } })),
    roles: [{ name: 'worker', accounts: ['ready', 'disabled', 'spent'], concurrency: 1 }], reason: 'fixture',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  Object.assign(registry.accounts[2]!.quota, { state: 'exhausted', loggedIn: true, resetsAt: reset, reason: 'provider limit', source: 'operator' });
  const writes: any[] = [];
  const api = { read: async () => registry, write: async (_path: string, data: unknown) => { writes.push(data); } };
  await withEnv({ XDG_CONFIG_HOME: config, OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_DIR: undefined, OPENCODE_CONFIG_CONTENT: undefined, [hostAccountsVariable]: join(root, 'host-checks') }, async () => {
    const diagnostics: string[] = [];
    const result = String(await registryCommand({ hostId: 'host' }, ['account', 'check', 'ready'], api, { report: line => diagnostics.push(line), smoke: async () => ({ ok: true, error: null }) }));
    const output = [result, ...diagnostics].join('\n');
    assert.match(output, /shell.*loop.*results may be false/i);
    assert.ok(output.includes(globalFile) && output.includes(ownFile), 'override names both credential files');
    assert.match(output, /warning:.*overrides/i);
    const fingerprint = createHash('sha256').update('global-secret').digest('hex').slice(0, 12);
    assert.ok(output.includes(`sha256:${fingerprint}`), 'fingerprint identifies the effective global key');
    assert.doesNotMatch(output, /global-secret|account-secret/);
    assert.equal(writes.length, 1);
    await writeFile(globalFile, '{}');
    diagnostics.length = 0;
    const ownResult = String(await registryCommand({ hostId: 'host' }, ['account', 'check', 'ready'], api, { report: line => diagnostics.push(line), smoke: async () => ({ ok: true, error: null }) }));
    const own = [ownResult, ...diagnostics].join('\n');
    assert.ok(own.includes(ownFile));
    assert.ok(own.includes(createHash('sha256').update('account-secret').digest('hex').slice(0, 12)));
    assert.doesNotMatch(own, /overrides/);
    for (const key of ['{env:ZAI_API_KEY}', `{file:${ownFile}}`, 'account-secret']) {
      await writeFile(globalFile, JSON.stringify({ provider: { zai: { options: { apiKey: key } } } }));
      diagnostics.length = 0;
      await registryCommand({ hostId: 'host' }, ['account', 'check', 'ready'], api, { report: line => diagnostics.push(line), smoke: async () => ({ ok: true, error: null }) });
      assert.doesNotMatch(diagnostics.join('\n'), /overrides/, key);
      assert.ok(diagnostics.includes(`Credential: ${ownFile} (sha256:${createHash('sha256').update('account-secret').digest('hex').slice(0, 12)})`));
    }
    await writeFile(join(config, 'opencode', 'provider.key'), 'file-secret');
    await writeFile(globalFile, '// JSONC and relative file references use the config directory\n' + JSON.stringify({ provider: { zai: { options: { apiKey: '{file:./provider.key}' } } } }));
    diagnostics.length = 0;
    await registryCommand({ hostId: 'host' }, ['account', 'check', 'ready'], api, { report: line => diagnostics.push(line), smoke: async () => ({ ok: true, error: null }) });
    assert.ok(diagnostics.some(line => line.includes(join(config, 'opencode', 'provider.key')) && line.includes(createHash('sha256').update('file-secret').digest('hex').slice(0, 12))));
    assert.doesNotMatch(diagnostics.join('\n'), /file-secret/);
  });
  const command = commands.find(command => command.name === 'accounts');
  assert.ok(command, 'mainworks accounts is registered');
  const context = await createContext('accounts', 'health', [], false);
  context.api = async (path: string) => { assert.equal(path, 'agent-registry'); return fleetView(registry, Date.now()); };
  const printed: string[] = [], log = console.log;
  console.log = (...values: unknown[]) => { printed.push(values.join(' ')); };
  try { await command.run(context, undefined); } finally { console.log = log; }
  const table = printed.join('\n');
  assert.doesNotMatch(table, /\\[tn]/, 'stdout contains real tabs and newlines, not JSON escapes');
  const rows = table.split('\n');
  assert.equal(rows.length, 4, table);
  assert.match(rows[0]!, /Account.*Runtime.*Role.*Launch.*Reason.*Reset/);
  assert.match(rows[1]!, /ready.*opencode.*worker.*yes/);
  assert.match(rows[2]!, /disabled.*opencode.*worker.*no.*disabled/);
  assert.match(rows[3]!, /spent.*opencode.*worker.*no.*exhausted/);
  assert.doesNotMatch(table, /is disabled|spent quota|master registry|\d{4}-\d\d-\d\dT/);
  assert.equal(rows[1]!.trim().split(/\s{2,}/).at(-1), '—');
  assert.ok(rows[3]!.includes(new Date(reset).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
  assert.match(rows[3]!, /\(in 59m\)|\(in 1h\)/);
});


test('account login fingerprint covers the effective token, not refreshed login metadata', async () => {
  const home = await temporaryDirectory('account-login-fingerprint');
  for (const kind of ['claude', 'codex'] as const) {
    const runtime = structuredClone(proposedRuntimes.find(runtime => runtime.name === kind)!);
    const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
      runtimes: [runtime], models: [{ name: 'model', id: 'fixture/model' }],
      accounts: [{ name: 'login', runtime: kind, model: 'model', credential: { host: 'host', home } }], reason: 'fixture',
    }, { actor: 'operator', at: new Date().toISOString() }).registry;
    const file = join(home, runtime.launch.loginFile!);
    const outputs: string[][] = [];
    for (const refresh of ['before', 'after']) {
      const login = kind === 'claude' ? { claudeAiOauth: { accessToken: 'fixture-token', refreshToken: refresh } }
        : { tokens: { access_token: 'fixture-token', refresh_token: refresh }, last_refresh: refresh };
      await writeFile(file, JSON.stringify(login));
      outputs.push(await accountCheckDiagnostics(registry.accounts[0]!, runtime, 'fixture/model'));
    }
    assert.deepEqual(outputs[0], outputs[1]);
    assert.ok(outputs[0]!.includes(`Credential: ${file} (sha256:${createHash('sha256').update('fixture-token').digest('hex').slice(0, 12)})`));
    assert.doesNotMatch(outputs.flat().join('\n'), /fixture-token|before|after/);
  }
});
