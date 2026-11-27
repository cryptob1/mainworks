import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../../src/master/config.js';
import { type WorkerProfile } from '../../src/master/profiles.js';
import type { FleetClient } from '../../src/fleet.js';
import type { HeadlessExec } from '../../src/headless-session.js';
import { applyRegistryMutation } from '../../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../../src/model/registry.js';
import { foldObservations } from '../../src/model/registry-sessions.js';
import { temporaryDirectory } from './temp-dirs.js';

/**
 * GY-3632: an installation with a registry of two Claude worker accounts and a stub runtime. Each
 * worker run is recorded with its runtime words, request and directory, and prints the session id
 * `session(n)` names (null prints none); `fail(args)` makes a run exit at once with an error.
 * `launch` overrides the stored Claude runtime contract (GY-3687: one that names no model flag).
 */
export async function builderFixture(label: string, launch: { modelFlag?: string | null; args?: string[] } = {}) {
  const holder = await temporaryDirectory(label), root = join(holder, 'repository'), credentials = join(holder, 'credentials');
  await mkdir(root); await mkdir(credentials, { mode: 0o700 });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials, herdrWorkspace: 'w1V' }, coordinatorStatus);
  const master = await loadMasterConfig(root), hostId = master.hostId ?? 'unknown-host';
  await mkdir(dirname(master.credentialFile), { recursive: true });
  const workerDirectory = join(holder, 'worker-credentials'), credentialFile = join(workerDirectory, 'worker.token');
  await mkdir(workerDirectory, { mode: 0o700 });
  await writeFile(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile: WorkerProfile = { name: 'registry-worker', principal: 'worker', agentName: 'builder', mode: 'launch', kind: 'claude', credentialFile, agentArgs: [], approvals: 'auto', environment: {} };
  const at = new Date().toISOString();
  let registry: AgentRegistry = applyRegistryMutation(emptyRegistry(), 'apply', { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude').map(runtime => ({ ...runtime, launch: { ...runtime.launch, ...launch } })),
    models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: ['claude-a', 'claude-b'].map(name => ({ name, runtime: 'claude', model: 'opus', credential: { host: hostId, home: null } })),
    roles: [{ name: 'worker', accounts: ['claude-a', 'claude-b'], concurrency: 4 }], reason: 'fixture' }, { actor: 'operator', at }).registry;
  const client: FleetClient = {
    document: async () => structuredClone(registry),
    observe: async request => { foldObservations(registry, request, { actor: 'executor', at }); },
    select: async request => {
      foldObservations(registry, { host: request.host, observations: request.observations }, { actor: 'executor', at });
      const choice = chooseSession(registry, request, Date.now());
      if (!choice.account) return { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      const session: FleetSession = { id: `session-${registry.sessions.length + 1}`, role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
        selectedAt: at, selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
      registry = { ...registry, sessions: [...registry.sessions, session] };
      return { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
    },
    end: async id => { registry = { ...registry, sessions: registry.sessions.map(session => session.id === id ? { ...session, endedAt: at, endReason: 'ended' } : session) }; },
  };
  const runs: { runtime: string[]; request: string; cwd: string; account: string | null }[] = [];
  let session: (n: number) => string | null = n => `session-${n}`;
  let fail: (runtime: string[]) => boolean = () => false;
  const exec: HeadlessExec = async (_command, args, options) => {
    const runtime = args.slice(args.indexOf('--') + 1);
    runtime[0] = basename(runtime[0]!);
    const account = registry.sessions.filter(entry => !entry.endedAt).at(-1)?.account ?? null;
    runs.push({ runtime: runtime.slice(0, -1), request: runtime.at(-1)!, cwd: String(options.cwd), account });
    const id = session(runs.length), log = (text: string) => appendFileSync(join(options.run, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), stream: 'stdout', text })}\n`);
    if (fail(runtime)) { log('Error: No conversation found with that session ID'); throw new Error('exited with code 1'); }
    log(JSON.stringify({ type: 'result', result: 'done', ...(id ? { session_id: id } : {}) }));
    return '';
  };
  const disable = (name: string) => { registry = { ...registry, accounts: registry.accounts.map(account => account.name === name ? { ...account, enabled: false } : account) }; };
  return {
    root, profile, client, exec, runs, disable, hostId,
    printSessions: (next: (n: number) => string | null) => { session = next; },
    failWhen: (next: (runtime: string[]) => boolean) => { fail = next; },
    probe: () => ({ registry: client, quota: false, cacheMs: 0, smoke: async () => ({ ok: true }), now: () => Date.now() }) as never,
  };
}
