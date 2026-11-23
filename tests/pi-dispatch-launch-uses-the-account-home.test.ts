import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { proposedRuntimes } from '../src/model/registry.js';
import { readOnlyMountWrapper } from '../src/master/confinement.js';
import { workerSessionLaunch } from '../src/runner/pi-launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3738: pi-b's auth.json names its Z.AI key by a `!` command that reads an OpenCode account's
// home. The worker sandbox masks every other account's home, so the command read nothing there and
// every Pi worker exited "No API key found for zai" while the unconfined role smoke passed.
test('unit:pi-dispatch-launch-uses-the-account-home — a Pi launch claimed by a Claude-named worker runs on the account home, bound and keyed in its sandbox', async () => {
  const root = await temporaryDirectory('pi-dispatch'), home = join(root, 'pi-b'), opencode = join(root, 'opencode-b');
  await mkdir(home, { recursive: true });
  await mkdir(opencode, { recursive: true });
  await writeFile(join(opencode, 'key'), 'fixture-zai-key\n', { mode: 0o600 });
  await writeFile(join(home, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: `!cat ${join(opencode, 'key')}` } }), { mode: 0o600 });
  const pi = proposedRuntimes.find(runtime => runtime.name === 'pi')!;
  const account = { name: 'pi-b', kind: 'pi', home, key: null,
    fleet: { runtime: 'pi', contract: pi.launch, model: 'pi-glm-5.4', modelId: 'zai/glm-5.4', session: 'session-1', reason: 'worker', role: 'worker' } } as const;
  const config = { credentialFile: join(root, 'config', 'master.token'), environments: [{ name: 'opencode-b', kind: 'opencode' as const, home: opencode }] };
  const profile = { name: 'claude-primary', kind: 'claude' as const, principal: 'graphyard-claude-2', approvals: 'auto' as const, agentArgs: [], environment: {}, credentialFile: join(root, 'workers', 'graphyard-claude-2.token') };

  const launch = await workerSessionLaunch(config, profile, account as never, { repositoryRoot: root });
  assert.equal(launch.kind, 'pi', 'the account decides the runtime, not the claiming worker identity');
  assert.equal(launch.environment.PI_CODING_AGENT_DIR, home);
  assert.equal(launch.environment.ZAI_API_KEY, 'fixture-zai-key', 'the key its auth.json command names is resolved on the host, where the other account home is readable');
  assert.equal(launch.environment.CLAUDE_CONFIG_DIR, undefined);

  const words = readOnlyMountWrapper({ coordinatorRoot: process.cwd(), sessionDirectory: join(root, 'worktree'), bwrap: 'bwrap', environment: launch.environment, secretsBus: null, credentialMask: launch.credentialMask });
  const bound = words.some((word, index) => word === '--bind' && words[index + 1] === home && words[index + 2] === home);
  assert.ok(bound, `the account home is bound into the sandbox: ${words.join(' ')}`);
  const masked = words.some((word, index) => word === '--tmpfs' && words[index + 1] === opencode);
  assert.ok(masked, 'the other account home stays masked');
});
