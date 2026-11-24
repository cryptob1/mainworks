import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAccountLive } from '../src/fleet.js';
import { launchPlan } from '../src/harness.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { emptyRegistry, proposedRuntimes } from '../src/model/registry.js';
import { smokeRegistryAccount } from '../src/runner/roles.js';

// GY-3749: a signed-in Cursor account failed its own live check — the check ran `-p` without the
// folder-trust flag its sessions use, so Cursor refused at its workspace-trust prompt.
const now = Date.parse('2026-11-23T20:00:00Z');

async function fixture(reply: string) {
  process.env[hostAccountsVariable] = await temporaryDirectory('cursor-live-check-host');
  const home = await temporaryDirectory('cursor-live-check');
  const runtime = structuredClone(proposedRuntimes.find(entry => entry.name === 'cursor')!);
  const registry = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [runtime], models: [{ name: 'cursor-default', id: 'auto' }],
    accounts: [{ name: 'cursor-a', runtime: 'cursor', model: 'cursor-default', credential: { host: 'host', home } }],
    roles: [{ name: 'reviewer', accounts: ['cursor-a'], concurrency: 1 }], reason: 'GY-3749 fixture',
  }, { actor: 'operator', at: new Date(now - 86_400_000).toISOString() }).registry;
  const launcher = join(home, 'launcher.cjs');
  await writeFile(launcher, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(home, 'call.json'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n${reply === 'OK' ? 'console.log' : 'console.error'}(${JSON.stringify(reply)});\n${reply === 'OK' ? '' : 'process.exit(1);\n'}`, { mode: 0o700 });
  const quota = await checkAccountLive(registry.accounts[0]!, registry.runtimes[0]!, { now: () => now, smoke: target => smokeRegistryAccount(target, { command: launcher, timeoutMs: 5000 }) }, 'auto');
  const call = JSON.parse(await readFile(join(home, 'call.json'), 'utf8')) as { args: string[]; cwd: string };
  return { quota, call };
}

test('unit:cursor-live-check-trusts-the-folder — the check passes the trust flag its sessions use, from the install\'s checkout', async () => {
  const { quota, call } = await fixture('OK');
  assert.equal(quota.state, 'available');
  assert.ok(call.args.includes('--trust'), `the check trusts the folder: ${call.args.join(' ')}`);
  const session = launchPlan('cursor', 'auto', []).args;
  assert.deepEqual(call.args.filter(arg => session.includes(arg)), session, 'with the session recipe\'s trust handling');
  assert.equal(call.cwd, process.cwd(), 'from the install\'s checkout, not the login home');
});

test('unit:cursor-live-check-trusts-the-folder — a signed-out account still reads not logged in', async () => {
  const { quota } = await fixture("Authentication required. Please run 'agent login' first.");
  assert.equal(quota.state, 'broken');
  assert.equal(quota.loggedIn, false);
});
