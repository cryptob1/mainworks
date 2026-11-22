import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { checkAccountLive, pinRuntime, proposeFleet } from '../src/fleet.js';
import { headlessArgv } from '../src/headless-session.js';
import { hostAccountsVariable } from '../src/host-accounts.js';
import { accountLaunch } from '../src/master/environments.js';
import { opencodeAuthList, opencodeModels } from '../src/master/runtimes.js';
import { pinnedInstall, proposedRuntimes, repinRuntime, type FleetAccount } from '../src/model/registry.js';

// GY-3592: OpenCode 2.x keeps one background service per OS user, and every call without
// --standalone attaches to it whatever XDG_DATA_HOME says: the account's login is ignored and the
// service's free model answers. Every command Graphyard builds runs on a private server instead.
const scratch = await temporaryDirectory('opencode-standalone'), calls = join(scratch, 'calls');
await writeFile(join(scratch, 'opencode'), `#!/bin/sh
for a in "$@"; do [ "$a" = --help ] && { echo '  --standalone    Run with a private server instead of the background service'; exit 0; }; done
echo "$*" >> ${calls}
echo OK
`, { mode: 0o755 });
const path = process.env.PATH;
process.env.PATH = `${scratch}:${path}`;
after(() => { process.env.PATH = path; });
const opencode = proposedRuntimes.find(runtime => runtime.name === 'opencode')!;

test('unit:opencode-launches-are-standalone — the interactive launch, the one-task launch, auth list, models and the live check each carry --standalone once', async () => {
  const standalone = (args: readonly string[]) => args.filter(arg => arg === '--standalone').length;
  const interactive = accountLaunch({ kind: 'opencode', approvals: 'auto', agentArgs: [], environment: {} }, null);
  assert.equal(standalone(interactive.args), 1, `interactive: ${interactive.args.join(' ')}`);
  const oneTask = await headlessArgv({ kind: 'opencode', args: interactive.args }, 'REQUEST', process.env);
  assert.equal(standalone(oneTask), 1, `one-task: ${oneTask.join(' ')}`);
  const home = await temporaryDirectory('home', scratch);
  process.env[hostAccountsVariable] = await temporaryDirectory('host', scratch);
  await opencodeAuthList(home);
  await opencodeModels(home);
  const account = { name: 'opencode-b', runtime: 'opencode', model: 'glm-5.3', enabled: true, credential: { host: 'host', home }, quota: {} } as unknown as FleetAccount;
  assert.equal((await checkAccountLive(account, opencode, {}, 'zai-coding-plan/glm-5.3')).state, 'available');
  const [authList, models, liveCheck] = (await readFile(calls, 'utf8')).trim().split('\n').map(line => line.split(' '));
  assert.deepEqual(authList, ['auth', 'list', '--standalone']);
  assert.deepEqual(models, ['models', '--standalone']);
  assert.equal(liveCheck![0], 'run');
  assert.equal(standalone(liveCheck!), 1, `live check: ${liveCheck!.join(' ')}`);
});

test('unit:opencode-runtime-names-one-version — a proposed OpenCode runtime pins the version its PATH entry names, and a repin moves both', () => {
  const install = (version: string) => `/home/agent/.local/share/mise/installs/opencode/${version}/bin`;
  const proposal = proposeFleet([{ name: 'opencode-a', runtime: 'opencode', home: '/home/agent/opencode-a', loggedIn: true, quota: 'available', reason: null, login: null, source: 'environment' }], 'host', undefined, () => install('2.3.2'));
  const proposed = proposal.runtimes.find(runtime => runtime.name === 'opencode')!;
  assert.equal(proposed.launch.environment.PATH!.split(':')[0], install('2.3.2'));
  assert.equal(proposed.launch.environment.MISE_OPENCODE_VERSION, pinnedInstall(proposed)!.version);
  assert.equal(proposed.launch.environment.MISE_OPENCODE_VERSION, '2.3.2');
  const moved = repinRuntime(pinRuntime(opencode, () => install('2.2.5')), install('2.3.2'));
  assert.equal(moved.launch.environment.PATH!.split(':')[0], install('2.3.2'));
  assert.equal(moved.launch.environment.MISE_OPENCODE_VERSION, '2.3.2');
});
