import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import type { Store } from '../src/store.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { intentCommand } from '../src/cli/master/intent.js';
import type { MasterSession } from '../src/cli/master/session.js';
import { installDirectory } from '../src/install/secrets.js';
import { runSlackBridge, slackSettingsFile } from '../src/master/slack.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { listen } from './helpers/http-server.js';
import { apiOk } from './helpers/api.js';
import { eventually, fakeSlack } from './helpers/fake-slack.js';
import { messageThreads } from '../web/pages/master.js';

// GY-4073: the instruction round trip as the owner sets it up. The real `mainworks lead slack connect`
// stores the tokens; the loop's Slack app carries a channel message to the Lead; the loop's real cycle
// wakes the Lead session with it; the Lead's real `lead reply` posts back in the Slack thread.
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const appToken = `xapp-1-${'a'.repeat(40)}`, botToken = `xoxb-1-${'b'.repeat(40)}`;
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const closers: (() => Promise<void>)[] = [];
after(async () => { for (const close of closers.reverse()) await close(); });

test('e2e:slack-instruction-reaches-the-lead — lead slack connect binds a channel silently; a channel message wakes the Lead once and its reply posts in the Slack thread', async () => {
  const loop: Principal = { id: 'factory-master', role: 'coordinator' };
  const store: Store = await withDatabase('slack_instruction_e2e'); await store.init();
  const plane = await listen(server(new Engine(store, 120, 'owner/factory'), [loop].map(principal => ({ ...principal, token: token(principal) }))));
  closers.push(async () => { await plane.close(); await store.close(); });
  const api = (path: string, body?: unknown, key?: string) => apiOk(plane.url, token(loop), path, { body, key });

  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('slack-e2e', join(process.cwd(), '.graphyard'));
  const root = await temporaryDirectory('coordinator', scratch), configHome = await temporaryDirectory('config', scratch);
  (await gitRepo({ root, files: { 'README.md': 'Fixture.\n' } })).git('remote', 'add', 'origin', 'https://github.com/owner/factory.git');
  await setupMaster(root, { url: plane.url, token: token(loop), cliPath: cli, credentialDirectory: await temporaryDirectory('credentials', scratch), run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });

  // The owner connects the app with one command: tokens piped, nothing printed.
  const connected = spawnSync(process.execPath, [cli, 'lead', 'slack', 'connect', 'C0FACTORY', 'UOWNER'], { cwd: root, input: `${appToken} ${botToken}\n`, encoding: 'utf8', env: { ...process.env, MAINWORKS_CONFIG_HOME: configHome } });
  assert.equal(connected.status, 0, connected.stderr);
  assert.equal(connected.stdout, '', 'nothing is printed');
  const directory = installDirectory('owner-factory', configHome);
  assert.equal((await stat(slackSettingsFile(directory))).mode & 0o777, 0o600);

  const slack = await fakeSlack({ appToken, botToken, names: { UOWNER: 'Vish' } });
  closers.push(slack.close);
  const stopping = new AbortController();
  const bridge = runSlackBridge({ directory, api: slack.api, pollMs: 50, signal: stopping.signal, log: () => {}, mainworks: { get: path => api(path), post: (path, body, key) => api(path, body, key) } });
  closers.push(async () => { stopping.abort(); await bridge; });
  await slack.connected();

  // A channel message reaches the Lead session once, through the loop's real cycle.
  slack.message({ channel: 'C0FACTORY', user: 'UOWNER', text: 'File an item to add dark mode and release it', ts: '1700000100.000100' });
  const message = await eventually(async () => (await api('master/messages')).messages[0], 'the Lead message');
  assert.equal(message.source, 'Slack: Vish');
  // Lead › Messages names the Slack person, never the loop's identity.
  assert.deepEqual(messageThreads([message]).map(thread => [thread.peer, thread.entries[0]!.who]), [['Slack: Vish', 'Slack: Vish']]);
  const config = await loadMasterConfig(root), state = emptyDaemonState(config), inputs: string[] = [];
  const effects: DaemonEffects = {
    snapshot: () => api('work-snapshot'), agents: () => [{ name: config.masterAgentName, pane_id: 'factory:master', agent: 'claude', agent_status: 'idle' }],
    credentials: async () => ({}), closeSession: () => {}, dispatch: async () => undefined, persist: async () => {},
    masterMessages: async () => (await api('master/messages')).messages,
    masterSession: { wake: async (_pane, text) => { inputs.push(text); }, launch: async () => { throw new Error('the Lead session is live'); } },
  };
  for (let cycle = 0; cycle < 3; cycle++) await runCycle(config, state, effects);
  const woke = inputs.filter(input => input.includes('File an item to add dark mode and release it'));
  assert.equal(woke.length, 1, JSON.stringify(inputs));
  assert.match(woke[0]!, /from Slack: Vish .*the owner's own instruction.*master reply \d+ TEXT/);

  // The Lead answers with its real reply command; the answer posts in the Slack thread.
  await intentCommand({ id: 'reply', args: [String(message.id), 'Filed', 'GY-7', 'and', 'released', 'it.'], print: () => {}, root, master: config, masterApi: (path: string) => api(path), masterMutation: (path: string, data: unknown, key?: string) => api(path, data, key) } as unknown as MasterSession);
  const reply = await eventually(() => slack.posts.find(post => post.text === 'Filed GY-7 and released it.'), 'the reply in the Slack thread');
  assert.deepEqual(reply, { channel: 'C0FACTORY', thread_ts: '1700000100.000100', text: 'Filed GY-7 and released it.' });
});
