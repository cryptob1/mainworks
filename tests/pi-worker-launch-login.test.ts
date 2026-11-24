import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { accountLaunch } from '../src/master/environments.js';
import { headlessArgs } from '../src/headless-argv.js';
import { credentialMaskFor, readOnlyMountWrapper } from '../src/master/confinement.js';
import { runtimeLoginHomes } from '../src/master/profiles.js';
import { proposedRuntimes, emptyRegistry, type AgentRegistry } from '../src/model/registry.js';
import { registryCommand } from '../src/cli/master-registry.js';
import type { FleetLaunchAccount } from '../src/fleet.js';

// GY-3721: a Pi account in the worker role builds on its own Z.AI login. The worker's launch sets
// PI_CODING_AGENT_DIR to the account's registry home, keeps that home readable inside the worker
// sandbox, and names the provider and model from the registry model id, as the connect smoke does.
// Role set refuses a Pi worker whose worker-shaped smoke cannot authenticate.

const pi = proposedRuntimes.find(runtime => runtime.name === 'pi')!;

test('unit:pi-worker-launch-carries-its-login — a Pi worker launch carries its home, keeps it readable in the sandbox and names provider and model; role set refuses a Pi worker that cannot authenticate', async () => {
  const holder = await temporaryDirectory('pi-worker-login');
  // The home sits under the operator config home, which the worker mask hides wholesale: only the session's own login comes back.
  const config = join(holder, 'config'), home = join(config, 'environments', 'pi-a'), root = join(holder, 'repository'), worktree = join(root, 'assigned');
  await mkdir(home, { recursive: true }); await mkdir(worktree, { recursive: true });
  await writeFile(join(home, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'fixture-key' } }), { mode: 0o600 });
  execFileSync('git', ['init', '-q', root]);
  const account: FleetLaunchAccount = { name: 'pi-a', kind: 'pi', home, fleet: { runtime: 'pi', contract: pi.launch, model: 'glm', modelId: 'zai/glm-5.3', session: 's-1', reason: 'fixture', role: 'worker' } };
  const launch = accountLaunch({ kind: 'pi', approvals: 'auto', agentArgs: [], environment: {} }, account, { headless: true });
  assert.equal(launch.environment.PI_CODING_AGENT_DIR, home, 'the worker starts on the account\'s registry home');

  const argv = headlessArgs('pi', launch.args, 'do the work', launch.contract);
  const at = argv.indexOf('--provider');
  assert.ok(at >= 0, `the launch names the provider: ${argv.join(' ')}`);
  assert.deepEqual(argv.slice(at, at + 4), ['--provider', 'zai', '--model', 'glm-5.3'], 'provider and model come from the registry model id');
  assert.ok(!argv.includes('zai/glm-5.3'), 'the joined id is not passed as the model');

  const mask = credentialMaskFor({ credentialFile: join(config, 'install', 'coordinator.token') } as never, { credentialFile: null, runtimeHomes: runtimeLoginHomes(launch.environment, launch.contract?.homeVariable, launch.kind) }, config);
  const wrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: worktree, bwrap: 'bwrap', credentialMask: mask, environment: launch.environment });
  const masked = wrapper.findIndex((word, index) => wrapper[index - 1] === '--tmpfs' && word === config);
  const bound = wrapper.findIndex((word, index) => wrapper[index - 1] === '--bind' && word === home && wrapper[index + 1] === home);
  assert.ok(masked > 0, `the config home is masked: ${wrapper.join(' ')}`);
  assert.ok(bound > masked, 'the account home is bound back after the mask, so the login is readable inside the sandbox');

  // Role set worker runs the worker-shaped smoke on a newly named Pi account and refuses it on failure.
  const registry: AgentRegistry = { ...emptyRegistry(), runtimes: [pi], models: [{ name: 'glm', id: 'zai/glm-5.3' } as never],
    accounts: [{ name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host: 'host-1', home } } as never], roles: [{ name: 'worker', accounts: [], concurrency: 2 } as never] };
  const writes: unknown[] = [];
  const api = { read: async () => registry, write: async (_path: string, data: unknown) => { writes.push(data); return data; } };
  const smoked: FleetLaunchAccount[] = [];
  const failing = async (target: FleetLaunchAccount) => { smoked.push(target); return { ok: false, error: 'No API key found for zai' }; };
  await assert.rejects(registryCommand({ hostId: 'host-1' }, ['role', 'set', 'worker', 'pi-a', '--reason', 'build'], api, { smoke: failing }), (error: Error) => {
    assert.equal(error.message.split('\n').length, 1, 'the refusal is one line');
    assert.match(error.message, /pi-a/);
    assert.match(error.message, /No API key found for zai/);
    return true;
  });
  assert.equal(writes.length, 0, 'a refused role set writes nothing');
  assert.equal(smoked[0]?.home, home);
  assert.equal(smoked[0]?.fleet.modelId, 'zai/glm-5.3');
  await registryCommand({ hostId: 'host-1' }, ['role', 'set', 'worker', 'pi-a', '--reason', 'build'], api, { smoke: async () => ({ ok: true, error: null }) });
  assert.equal(writes.length, 1, 'a Pi account whose smoke passes joins the worker role');

  // The default smoke is the real one: a stub Pi that answers only with the provider flags and a login under its home.
  const bin = await temporaryDirectory('pi-worker-login-bin');
  await writeFile(join(bin, 'pi'), `#!/bin/sh
case " $* " in *" --provider zai --model glm-5.3 "*) ;; *) echo "unknown model" >&2; exit 1;; esac
[ -f "$PI_CODING_AGENT_DIR/auth.json" ] || { echo "No API key found for zai" >&2; exit 1; }
echo '{"type":"message_end","message":{"role":"assistant","content":"OK","model":"glm-5.3"}}'
`);
  await chmod(join(bin, 'pi'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    await registryCommand({ hostId: 'host-1' }, ['role', 'set', 'worker', 'pi-a', '--reason', 'build'], api);
    assert.equal(writes.length, 2, 'the real smoke authenticates with the home\'s login');
    registry.accounts[0]!.credential.home = join(holder, 'empty');
    await mkdir(join(holder, 'empty'));
    await assert.rejects(registryCommand({ hostId: 'host-1' }, ['role', 'set', 'worker', 'pi-a', '--reason', 'build'], api), /pi-a .*No API key found for zai/);
  } finally { process.env.PATH = path; }
});
