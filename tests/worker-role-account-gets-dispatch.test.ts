import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork } from '../src/master/dispatch.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { type WorkerProfile } from '../src/master/profiles.js';
import type { FleetClient } from '../src/fleet.js';
import type { HeadlessExec } from '../src/headless-session.js';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';
import { foldObservations } from '../src/model/registry-sessions.js';
import { workersAllowed } from '../src/master/worker-pool.js';
import { workersCommand } from '../src/cli/master-registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

/**
 * GY-3730: the registry's worker role decides who builds. master.json holds only a claude profile
 * (an identity), yet a Pi account placed first in the role takes the dispatch on its own runtime;
 * and a role account whose runtime has no launcher is named, not counted as capacity.
 */
function registryWith(hostId: string, roleOrder: string[]): AgentRegistry {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [...proposedRuntimes.filter(runtime => ['pi', 'claude'].includes(runtime.name)), { name: 'mystery', launch: { kind: 'mystery', args: [] } }],
    models: [{ name: 'glm', id: 'zai/glm-5.3' }, { name: 'opus', id: 'claude-opus-5' }],
    accounts: [
      { name: 'pi-a', runtime: 'pi', model: 'glm', credential: { host: hostId, home: null } },
      { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } },
      { name: 'mystery-a', runtime: 'mystery', model: 'opus', credential: { host: hostId, home: null } },
    ],
    roles: [{ name: 'worker', accounts: roleOrder, concurrency: 3 }], reason: 'fixture',
  }, { actor: 'operator', at: new Date().toISOString() }).registry;
}

test('unit:worker-role-account-gets-dispatch — role order pi, claude with no Pi profile in master.json dispatches to pi; an account whose runtime has no launcher is named, not counted', async () => {
  const holder = await temporaryDirectory('worker-role-account'), root = join(holder, 'repository'), credentials = join(holder, 'credentials');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials, herdrWorkspace: 'w1V' }, coordinatorStatus);
  const master = await loadMasterConfig(root), hostId = master.hostId ?? 'unknown-host';
  const workerDirectory = join(holder, 'worker-credentials'), credentialFile = join(workerDirectory, 'worker.token');
  await mkdir(workerDirectory, { mode: 0o700 });
  await writeFile(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await mkdir(join(root, 'assigned'), { recursive: true });
  await mkdir(dirname(master.credentialFile), { recursive: true });
  // The only profile master.json holds is a claude one: no Pi profile exists.
  const profile: WorkerProfile = { name: 'claude-primary', principal: 'graphyard-worker-1', agentName: 'eng-claude', mode: 'launch', kind: 'claude', credentialFile, agentArgs: [], approvals: 'auto', environment: {} };
  const item = workFixture({ id: 'work-3730', key: 'GY-3730', title: 'Role builds', priority: 1, lane: 'low', pipeline: { reworkRounds: 0, attempts: [] } as never, createdAt: '', updatedAt: '', stageEnteredAt: '',
    criteria: [{ id: 'AC-1', text: 'Edits src/master/worker-pool.ts and tests/worker-role-account-gets-dispatch.test.ts', proofs: ['unit:worker-role-account-gets-dispatch'] }] }) as any;

  const at = new Date().toISOString();
  let registry = registryWith(hostId, ['pi-a', 'claude-b']);
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    observe: async request => { foldObservations(registry, request, { actor: 'executor', at }); },
    select: async request => {
      foldObservations(registry, { host: request.host, observations: request.observations }, { actor: 'executor', at });
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: 'session-1', role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session] };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async id => { registry = { ...registry, sessions: registry.sessions.map(session => session.id === id ? { ...session, endedAt: at, endReason: 'ended' } : session) }; },
  };
  const kinds: string[] = [];
  const exec: HeadlessExec = async (_command, args) => { kinds.push(basename(args[args.indexOf('--') + 1] ?? '')); return ''; };
  const prepare = async () => ({ epoch: 1, path: join(root, 'assigned'), base: 'c'.repeat(40) });
  const dispatched = await dispatchWork(root, item, profile, { allWork: [item], prepare, release: async () => {}, observedAt: at, headless: exec,
    probe: { registry: client, quota: false, cacheMs: 0, smoke: async () => ({ ok: true }), now: () => Date.parse(at) } as never });
  assert.equal(dispatched.account?.environment, 'pi-a', 'the first account of the worker role builds, though master.json names no Pi profile');
  assert.equal(dispatched.runtime, 'pi', 'the launch is built from the account\'s runtime, not the profile\'s kind');
  assert.deepEqual(kinds, ['pi'], 'the Pi runtime is the one started');

  // An account whose runtime has no launcher is named in one line and not counted.
  const fleet = registryWith(hostId, ['pi-a', 'mystery-a', 'claude-b']);
  assert.equal(workersAllowed(master, fleet), 6, 'two launchable accounts × 3 each; mystery-a is not capacity');
  const report = await workersCommand([], { read: async () => fleet, write: async () => { throw new Error('no change was asked for'); } });
  assert.equal(report.allowed, 6);
  assert.match(report.line, /^6 workers allowed: 2 accounts × 3 each/);
  assert.equal(report.unlaunchable.length, 1);
  assert.match(report.unlaunchable[0], /mystery-a .*mystery.* no one-task launcher/);
  assert.equal(report.line.split('\n').length, 1, 'one line');
  assert.match(report.line, /Not counted: mystery-a/);
});
