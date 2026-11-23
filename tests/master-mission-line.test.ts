import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { ChildRun } from '../src/child-runner.js';
import { emptyRegistry, proposedRuntimes, unobservedQuota, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import type { FleetClient } from '../src/fleet.js';
import { masterMission, masterPrompt } from '../src/master/harness.js';
import { launchMasterSession } from '../src/master/master-session.js';
import { masterConfinementVariable } from '../src/master/confinement.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3521: every master starts from one mission paragraph, the same for every project and runtime,
// prepended once to the master prompt; the rest of the prompt is unchanged.

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const base = {
  repository: 'owner/project', cliPath: '/bin/graphyard.mjs', url: 'https://graphyard.example', credentialFile: '/credentials/master.token',
  hostId: 'host', baseBranch: 'main', workers: [], reviewers: [], producers: [], run: {},
} as unknown as MasterConfig;
// Each config's prompt word count beside the mission paragraph (GY-3491 cut the duplicated rules; GY-3530 added ask).
const configs: [MasterConfig, number][] = [
  [base, 196],
  [{ ...base, supervision: 'supervised' } as MasterConfig, 237],
  [{ ...base, repository: 'cryptob1/graphyard' }, 159],
];

test('integration:master-mission-line — the master prompt begins with the mission paragraph, identical for every project, in 45 words or fewer', () => {
  assert.ok(words(masterMission) <= 45, `the mission is ${words(masterMission)} words`);
  assert.match(masterMission, /world-class software/);
  assert.match(masterMission, /creative/);
  assert.match(masterMission, /innovat/);
  assert.match(masterMission, /resolve .* yourself.* before involving the owner/);
  for (const [config] of configs) assert.ok(masterPrompt(config).startsWith(`${masterMission} `), `${config.repository} prompt begins with the mission`);
});

test('integration:master-mission-line — the rest of the master prompt is unchanged: it grows by the mission\'s words only', () => {
  for (const [config, before] of configs) {
    const prompt = masterPrompt(config);
    assert.equal(words(prompt), before + words(masterMission), `${config.repository} (${config.supervision ?? 'autonomous'}) prompt grows by exactly the mission`);
    assert.equal(prompt.indexOf(masterMission, 1), -1, 'the mission appears once');
  }
});

test('e2e:master-mission-line — a started master session\'s first message contains the mission paragraph', { timeout: 180_000 }, async () => {
  const scratch = await temporaryDirectory('master-mission-line');
  const root = await realpath(await temporaryDirectory('checkout', scratch)), homes = await temporaryDirectory('accounts', scratch);
  const credentials = await temporaryDirectory('coordinator', scratch);
  await mkdir(join(scratch, '.claude'), { recursive: true });
  await writeFile(join(scratch, '.claude', 'settings.json'), '{}');
  execFileSync('git', ['init', '-q', root]);
  const binary = join(root, 'bin');
  await mkdir(binary, { recursive: true });
  const runtime = fileURLToPath(new URL('fixtures/master-runtime.mjs', import.meta.url));
  await writeFile(join(binary, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${runtime}' "$@"\n`, { mode: 0o700 });
  // A pass-through bwrap stub runs the command after the wrapper's `--`, so hosts that cannot nest namespaces run it too.
  await writeFile(join(binary, 'bwrap'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--" ]; then shift; exec "$@"; fi; shift; done\nexit 1\n', { mode: 0o700 });
  const home = await temporaryDirectory('claude-a', homes);
  const account = { name: 'claude-a', runtime: 'claude', model: 'test', credential: { host: 'test-host', home }, enabled: true, maxSessions: null, quota: { ...unobservedQuota } };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/mission', baseBranch: 'main', hostId: 'test-host', credentialFile: join(credentials, 'coordinator.token'), cliPath: '/bin/graphyard', githubAppId: 1, workers: [], masterAgentName: 'mission-master', run: { launchStartSeconds: 10 } });
  const registry: AgentRegistry = { ...emptyRegistry(), accounts: [account],
    runtimes: proposedRuntimes.filter(entry => entry.name === 'claude').map(entry => ({ ...entry, launch: { ...entry.launch, args: [...entry.launch.args, '--setting-sources', 'user'], environment: { PATH: `${binary}:${process.env.PATH}`, GY_RUNTIME: entry.name } } })),
    models: [{ name: 'test', id: null, cost: { inputPerMTok: null, outputPerMTok: null }, capability: { tier: 'strong', contextTokens: null } }],
    roles: [{ name: 'master', accounts: ['claude-a'], concurrency: 1 }] };
  const client: FleetClient = { document: async () => registry, end: async () => {}, select: async () => {
    const fleetRuntime = registry.runtimes.find(entry => entry.name === account.runtime)!;
    const session: FleetSession = { id: 'allocation-1', role: 'master', account: account.name, runtime: fleetRuntime.name, model: 'test', host: 'test-host', work: null, principal: 'master', selectedAt: new Date().toISOString(), selectedBy: 'master', reason: 'fixture account', skipped: [], endedAt: null, endReason: null };
    return { selected: true, reason: 'fixture account', skipped: [], session, account, runtime: fleetRuntime, model: registry.models[0], revision: 1 };
  } };
  const panes = new Map<string, { env: NodeJS.ProcessEnv; child?: ChildProcess }>();
  const resultFile = (pane: string) => join(root, '.graphyard', `${pane}.result.json`);
  let paneId = 0;
  const run: ChildRun = async (_command, args) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') {
      const pane = `pane-${++paneId}`;
      const env: NodeJS.ProcessEnv = { ...process.env, GY_RESULT: resultFile(pane) };
      for (let index = 0; index < args.length; index++) if (args[index] === '--env') { const value = args[++index], at = value.indexOf('='); env[value.slice(0, at)] = value.slice(at + 1); }
      panes.set(pane, { env });
      return json({ pane_id: pane, tab_id: `tab-${paneId}` });
    }
    if (args[0] === 'pane' && args[1] === 'run') {
      const pane = panes.get(args[2])!;
      pane.child = spawn('/bin/sh', ['-c', args[3]], { cwd: root, env: pane.env });
      pane.child.stderr!.on('data', () => {});
      return json({});
    }
    if (args[0] === 'agent' && args[1] === 'get') return json({ agent: { agent: 'claude', agent_status: panes.get(args[2])!.child?.exitCode === null ? 'working' : 'exited' } });
    if (args[0] === 'agent' && args[1] === 'rename') return json({});
    if (args[0] === 'pane' && args[1] === 'read') return json({ text: 'Claude Code fixture runtime ready' });
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    if (args[0] === 'pane' && args[1] === 'close') { const child = panes.get(args[2])?.child; if (child?.exitCode === null) { child.stdin?.end(); await once(child, 'exit').catch(() => {}); } return json({}); }
    throw new Error(`Unexpected fixture Herdr command ${args.join(' ')}`);
  };
  // The fixture process already stands inside its own boundary, as a real master session does.
  const hadConfinement = process.env[masterConfinementVariable];
  process.env[masterConfinementVariable] = 'master';
  try {
    const launched = await launchMasterSession(root, config, { agents: [], available: true }, 'Handover: continue from master status.', run,
      { registry: client, quota: false, smoke: async () => ({ ok: true, error: null }) });
    const result = JSON.parse(await readFile(resultFile(launched.pane), 'utf8'));
    assert.equal(result.id, launched.continuity!.current.nativeId, 'the launch really ran the fixture runtime');
    assert.ok((result.request as string).includes(masterMission), 'the session\'s first message contains the mission paragraph');
  } finally {
    if (hadConfinement === undefined) delete process.env[masterConfinementVariable]; else process.env[masterConfinementVariable] = hadConfinement;
    for (const pane of panes.values()) if (pane.child && pane.child.exitCode === null) { pane.child.stdin?.end(); await once(pane.child, 'exit').catch(() => {}); }
  }
});
