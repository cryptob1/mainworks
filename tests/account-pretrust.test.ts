import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { createAgentEnvironment, masterConfigSchema, prepareAgentEnvironment, setupAgentEnvironments, type MasterConfig } from '../src/master.js';
import { masterProfile } from '../src/master/master-session.js';
import { codexProjects, trustClaudeFolder } from '../src/harness.js';
import { selectFleetSession, type FleetClient, type FleetSelection } from '../src/fleet.js';
import { chooseSession, emptyRegistry, proposedRuntimes, unobservedQuota, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { foldObservations } from '../src/model/registry-sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const HOST = 'machine-pretrust';
const MASTER = 'graphyard-master-pretrust';
const iso = (at: number) => new Date(at).toISOString();

function registryFixture(now: () => number, accounts = [{ name: 'claude-a', runtime: 'claude' }, { name: 'claude-b', runtime: 'claude' }]) {
  let registry: AgentRegistry = emptyRegistry();
  const session = (id: string, account: string, runtime: string): FleetSession => ({
    id, role: 'master', account, runtime, model: 'opus', host: HOST, work: null, principal: MASTER,
    selectedAt: iso(now()), selectedBy: 'coordinator', reason: 'recorded', skipped: [], endedAt: null, endReason: null,
  });
  let seq = 0;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    observe: async request => foldObservations(registry, request, { actor: 'executor', at: iso(now()) }),
    select: async request => {
      foldObservations(registry, { host: request.host, observations: request.observations }, { actor: 'executor', at: iso(now()) });
      const choice = chooseSession(registry, request, now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision } satisfies FleetSelection;
      const added = session(`session-${++seq}-${choice.account.name}`, choice.account.name, choice.runtime.name);
      registry.sessions.push(added);
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session: added, account: choice.account, runtime: choice.runtime, model: choice.model, revision: registry.revision };
    },
    end: async (id, reason) => {
      const ended = registry.sessions.find(entry => entry.id === id && !entry.endedAt);
      if (ended) { ended.endedAt = iso(now()); ended.endReason = reason.slice(0, 500); }
    },
  };
  registry = structuredClone({
    ...registry,
    runtimes: proposedRuntimes.filter(runtime => accounts.some(account => account.runtime === runtime.name)),
    models: [{ name: 'opus', id: null }],
    accounts: accounts.map(account => ({ name: account.name, runtime: account.runtime, model: 'opus', enabled: true, credential: { host: HOST, home: null }, quota: { ...unobservedQuota } })),
    roles: [{ name: 'master', accounts: accounts.map(account => account.name), concurrency: 1, policy: {} }],
    revision: registry.revision + 1,
    updatedAt: iso(now()),
  } as AgentRegistry);
  return { client, live: () => registry.sessions.filter(entry => !entry.endedAt).map(entry => entry.account) };
}

async function masterConfig(label: string): Promise<MasterConfig> {
  const dir = await temporaryDirectory(label);
  return masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', credentialFile: join(dir, 'coordinator.token'),
    cliPath: '/bin/graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: HOST, masterAgentName: MASTER, workers: [],
  });
}

test('integration:account-pretrust — creating or logging in an agent environment records folder trust for every install checkout on the host, so its first launch there shows no trust prompt', async () => {
  const hostXdg = await temporaryDirectory('pretrust-xdg');
  const unitDir = join(hostXdg, 'systemd', 'user');
  const checkoutA = await temporaryDirectory('pretrust-checkout-a');
  const checkoutB = await temporaryDirectory('pretrust-checkout-b');
  const envRoot = await temporaryDirectory('pretrust-envs');
  const credDir = await temporaryDirectory('pretrust-creds');

  await mkdir(unitDir, { recursive: true });
  // checkoutA carries its own .claude/settings.json, just like a real repo checkout that used to refuse at launch.
  await mkdir(join(checkoutA, '.claude'), { recursive: true });
  await writeFile(join(checkoutA, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));
  await writeFile(join(unitDir, 'graphyard-master-app-a.service'), `[Service]\nWorkingDirectory=${checkoutA}\nExecStart=/usr/bin/node /bin/graphyard master run\n`);
  await writeFile(join(unitDir, 'graphyard-master-app-b.service'), `[Service]\nWorkingDirectory=${checkoutB}\nExecStart=/usr/bin/node /bin/graphyard master run\n`);

  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = hostXdg;
  try {
    // 1. Creating a new Claude environment records folder trust for every install checkout on the host.
    const createdClaude = await createAgentEnvironment(envRoot, 'claude', []);
    const claudeConfig = JSON.parse(await readFile(join(createdClaude.home, '.claude.json'), 'utf8'));
    assert.equal(claudeConfig.projects?.[realpathSync(checkoutA)]?.hasTrustDialogAccepted, true, 'checkoutA is trusted on create');
    assert.equal(claudeConfig.projects?.[realpathSync(checkoutB)]?.hasTrustDialogAccepted, true, 'checkoutB is trusted on create');
    // First launch in checkoutA succeeds without refusal or trust prompt, even with repository .claude/settings.json.
    const launchTrust = await trustClaudeFolder(checkoutA, { CLAUDE_CONFIG_DIR: createdClaude.home });
    assert.equal(launchTrust.written, false, 'already trusted before first launch');

    // 2. Creating a new Codex environment records trust_level = "trusted" for every install checkout on the host.
    const createdCodex = await createAgentEnvironment(envRoot, 'codex', [createdClaude]);
    const codexToml = await readFile(join(createdCodex.home, 'config.toml'), 'utf8');
    const trustedCodex = codexProjects(codexToml).filter(project => project.trust === 'trusted').map(project => project.path);
    assert.ok(trustedCodex.includes(realpathSync(checkoutA)), 'checkoutA is trusted in codex config.toml');
    assert.ok(trustedCodex.includes(realpathSync(checkoutB)), 'checkoutB is trusted in codex config.toml');

    // 3. Logging in an existing environment (e.g. after /login overwrote .claude.json) and running setupAgentEnvironments --apply restores trust for every host checkout.
    await writeFile(join(createdClaude.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'test@example.com' } }));
    const coordToken = join(credDir, 'coordinator.token');
    await writeFile(coordToken, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    execFileSync('git', ['init', '-q', checkoutB]);
    await mkdir(join(checkoutB, '.graphyard'), { recursive: true });
    await writeFile(join(checkoutB, '.graphyard', 'master.json'), JSON.stringify(masterConfigSchema.parse({
      version: 1, url: 'https://graphyard.example', credentialFile: coordToken, cliPath: resolve('bin/graphyard.mjs'),
      repository: 'owner/app-b', baseBranch: 'main', githubAppId: 1234, hostId: HOST, masterAgentName: MASTER, workers: [],
    })), { mode: 0o600 });
    await setupAgentEnvironments(checkoutB, { directory: envRoot, apply: true, verify: async () => ({}) });
    const afterLogin = JSON.parse(await readFile(join(createdClaude.home, '.claude.json'), 'utf8'));
    assert.equal(afterLogin.projects?.[realpathSync(checkoutA)]?.hasTrustDialogAccepted, true, 'checkoutA re-trusted after login');
    assert.equal(afterLogin.projects?.[realpathSync(checkoutB)]?.hasTrustDialogAccepted, true, 'checkoutB re-trusted after login');
    assert.deepEqual(await prepareAgentEnvironment(createdClaude), [], 'preparing an already-trusted environment is idempotent');
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
});

test('integration:account-pretrust — two identical launch failures for the master on one account make the loop pick the next eligible account, with one plain line saying why', async () => {
  let clock = Date.parse('2026-11-22T10:00:00Z');
  const config = await masterConfig('pretrust-failover');
  const registry = registryFixture(() => clock);
  const state = emptyDaemonState(config);
  const attempts: { account: string; exclude: string[] }[] = [];
  let paneSeq = 0;

  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: iso(clock) }),
    agents: () => [],
    herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => { throw new Error('no worker dispatch in this test'); },
    persist: async () => {},
    masterSession: {
      launch: async (_handover, _previous, options) => {
        const exclude = options?.exclude ?? [];
        const selected = (await selectFleetSession(config, 'master', { name: masterProfile }, {
          registry: registry.client, now: () => clock, runtime: { agents: [], available: true }, exclude,
        }))!;
        attempts.push({ account: selected.account.name, exclude: [...exclude] });
        if (selected.account.name === 'claude-a') {
          await selected.release('master session launch failed: workspace-trust prompt');
          throw Object.assign(
            new Error(`the claude runtime stopped at a workspace-trust prompt in pane w1V:p${++paneSeq}: "Yes, I trust this folder"`),
            { account: selected.account.name },
          );
        }
        return { agentName: MASTER, pane: `w1V:p${++paneSeq}`, runtime: selected.account.kind, account: selected.account.name, session: selected.account.fleet.session };
      },
      end: async (id, reason) => { await registry.client.end(id, reason); },
    },
  };

  // Cycle 1: first failure on claude-a — stays on claude-a, does not fail over yet.
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(attempts.map(entry => entry.account), ['claude-a']);
  assert.equal(state.master.account, null, 'master did not start after 1st failure');
  assert.equal(state.actions['master:launch']?.state, 'failed');

  // Cycle 2: second identical failure on claude-a — marks claude-a unusable for 1 hour and starts on claude-b.
  clock += 20_000;
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(attempts.map(entry => entry.account), ['claude-a', 'claude-a', 'claude-b']);
  assert.deepEqual(attempts[2]!.exclude, ['claude-a'], 'claude-a is excluded on the failover retry');
  assert.equal(state.master.account, 'claude-b', 'master started on the next eligible account');
  assert.equal(state.actions['master:launch']?.state, 'done');
  assert.deepEqual(registry.live(), ['claude-b']);
  const failover = state.actions['master:failover'];
  assert.equal(failover?.state, 'done');
  assert.match(failover!.detail, /claude-a/);
  assert.match(failover!.detail, /1 hour/);
  assert.ok(!failover!.detail.includes('\n'), 'failover reason is one plain line');

  // Within the 1-hour hold, if the master goes absent again, claude-a is still skipped.
  const bSession = state.master.session!;
  await registry.client.end(bSession, 'exited');
  state.master.agentName = null;
  state.master.pane = null;
  clock += 30 * 60_000;
  await runCycle(config, state, effects, () => clock);
  assert.equal(attempts.at(-1)!.account, 'claude-b', 'claude-a stays unusable during the 1-hour hold');
  assert.deepEqual(attempts.at(-1)!.exclude, ['claude-a']);

  // After 1 hour, claude-a is eligible again.
  await registry.client.end(state.master.session!, 'exited');
  state.master.agentName = null;
  state.master.pane = null;
  clock += 31 * 60_000;
  await runCycle(config, state, effects, () => clock);
  assert.equal(attempts.at(-1)!.account, 'claude-a', 'claude-a is eligible again after 1 hour');
  assert.deepEqual(attempts.at(-1)!.exclude, []);
});

test('e2e:account-pretrust — with the first account unable to launch, the master starts on the second within two cycles', async () => {
  let clock = Date.parse('2026-11-22T12:00:00Z');
  const config = await masterConfig('pretrust-e2e');
  const registry = registryFixture(() => clock);
  const state = emptyDaemonState(config);
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: iso(clock) }),
    agents: () => [],
    herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => { throw new Error('no worker dispatch'); },
    persist: async () => {},
    masterSession: {
      launch: async (_handover, _previous, options) => {
        const selected = (await selectFleetSession(config, 'master', { name: masterProfile }, {
          registry: registry.client, now: () => clock, runtime: { agents: [], available: true }, exclude: options?.exclude,
        }))!;
        if (selected.account.name === 'claude-a') {
          await selected.release('master session launch failed: unable to launch');
          throw Object.assign(new Error('the claude runtime stopped at a workspace-trust prompt in pane w1V:p1'), { account: 'claude-a' });
        }
        return { agentName: MASTER, pane: 'w1V:p2', runtime: selected.account.kind, account: selected.account.name, session: selected.account.fleet.session };
      },
      end: async (id, reason) => { await registry.client.end(id, reason); },
    },
  };

  for (let cycle = 1; cycle <= 2; cycle++) {
    await runCycle(config, state, effects, () => clock);
    clock += 15_000;
  }
  assert.equal(state.master.account, 'claude-b', 'master started on the second account within two cycles');
  assert.equal(state.actions['master:launch']?.state, 'done');
  assert.deepEqual(registry.live(), ['claude-b']);
});

test('integration:account-pretrust — never holds the last eligible account for an hour when no next account can run', async () => {
  // 1. Single-account install: two identical failures fall back to launch backoff instead of a 1-hour lockout.
  let clock = Date.parse('2026-11-22T14:00:00Z');
  const singleConfig = await masterConfig('pretrust-single');
  const singleRegistry = registryFixture(() => clock, [{ name: 'claude-a', runtime: 'claude' }]);
  const singleState = emptyDaemonState(singleConfig);
  let broken = true;
  const singleEffects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: iso(clock) }),
    agents: () => [],
    herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => { throw new Error('no worker dispatch'); },
    persist: async () => {},
    masterSession: {
      launch: async (_handover, _previous, options) => {
        const selected = (await selectFleetSession(singleConfig, 'master', { name: masterProfile }, {
          registry: singleRegistry.client, now: () => clock, runtime: { agents: [], available: true }, exclude: options?.exclude,
        }))!;
        if (broken) {
          await selected.release('master session launch failed: timed out');
          throw Object.assign(new Error('master session did not start in pane w1V:p1'), { account: selected.account.name });
        }
        return { agentName: MASTER, pane: 'w1V:p2', runtime: selected.account.kind, account: selected.account.name, session: selected.account.fleet.session };
      },
      end: async (id, reason) => { await singleRegistry.client.end(id, reason); },
    },
  };

  await runCycle(singleConfig, singleState, singleEffects, () => clock);
  clock += 15_000;
  await runCycle(singleConfig, singleState, singleEffects, () => clock);
  assert.deepEqual(singleState.master.unusableAccounts, {}, 'single account is not held for an hour');
  assert.equal(singleState.actions['master:failover'], undefined, 'no misleading failover recorded when no next account exists');
  assert.equal(singleState.actions['master:launch']?.state, 'failed');
  assert.equal(singleState.actions['master:launch']?.attempts, 2);

  // 3rd identical failure engages existing backoff; once fixed after 1 minute it launches immediately.
  clock += 15_000;
  await runCycle(singleConfig, singleState, singleEffects, () => clock);
  assert.equal(singleState.actions['master:launch']?.attempts, 3);
  assert.match(singleState.actions['master:launch']!.detail, /backs off/);
  broken = false;
  clock += 61_000;
  await runCycle(singleConfig, singleState, singleEffects, () => clock);
  assert.equal(singleState.master.account, 'claude-a', 'single account launches once the transient failure clears');

  // 2. Multi-account install with a host-level failure: once every account would be held, holds lift for backoff.
  let hostClock = Date.parse('2026-11-22T15:00:00Z');
  const hostConfig = await masterConfig('pretrust-host-fault');
  const hostRegistry = registryFixture(() => hostClock);
  const hostState = emptyDaemonState(hostConfig);
  let hostBroken = true;
  const hostEffects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: iso(hostClock) }),
    agents: () => [],
    herdr: () => ({ agents: [], available: true }),
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => { throw new Error('no worker dispatch'); },
    persist: async () => {},
    masterSession: {
      launch: async (_handover, _previous, options) => {
        const selected = (await selectFleetSession(hostConfig, 'master', { name: masterProfile }, {
          registry: hostRegistry.client, now: () => hostClock, runtime: { agents: [], available: true }, exclude: options?.exclude,
        }))!;
        if (hostBroken) {
          await selected.release('master session launch failed: host confinement error');
          throw Object.assign(new Error('confinement refused launch in pane w1V:p1'), { account: selected.account.name });
        }
        return { agentName: MASTER, pane: 'w1V:p9', runtime: selected.account.kind, account: selected.account.name, session: selected.account.fleet.session };
      },
      end: async (id, reason) => { await hostRegistry.client.end(id, reason); },
    },
  };

  for (let i = 0; i < 3; i++) {
    await runCycle(hostConfig, hostState, hostEffects, () => hostClock);
    hostClock += 15_000;
  }
  assert.deepEqual(hostState.master.unusableAccounts, {}, 'holds lift once every account fails the host fault');
  assert.equal(hostState.actions['master:launch']?.attempts, 3, 'existing backoff takes over on the 3rd failure');
  hostBroken = false;
  hostClock += 61_000;
  await runCycle(hostConfig, hostState, hostEffects, () => hostClock);
  assert.equal(hostState.master.account, 'claude-a', 'master recovers as soon as the host fault clears');
});
