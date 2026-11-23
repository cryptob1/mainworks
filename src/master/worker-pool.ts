// Concern: the worker pool follows the registry's worker role (GY-3285).
import { dirname, join } from 'node:path';
import { atomicPrivateText } from '../private-file.js';
import { roleLimit } from '../model/registry.js';
import { headlessKind } from '../headless-argv.js';
import { sessionNameLimit } from '../session-name.js';
import { saveWorkerProfile } from './config.js';
import { MAX_WORKER_PROFILES, type MasterConfig, type WorkerProfile } from './profiles.js';

type WorkerFleet = { runtimes: readonly { name: string; launch: { kind: string; headlessArgs?: string[] } }[]; accounts: readonly { name: string; runtime: string }[]; roles: readonly { name: string; accounts: readonly string[]; concurrency: number }[] };
/**
 * GY-3730: the worker role's accounts a worker launch can start — a registered account whose
 * runtime has a one-task launcher — and, for each it cannot, the account and why.
 */
export function workerAccounts(registry: WorkerFleet) {
  const unlaunchable: string[] = [];
  const launchable = (registry.roles.find(entry => entry.name === 'worker')?.accounts ?? []).filter(name => {
    const account = registry.accounts.find(entry => entry.name === name), runtime = registry.runtimes.find(entry => entry.name === account?.runtime);
    const reason = !account ? 'is not a registered account' : !runtime ? `runs runtime ${account.runtime}, which is not registered`
      : !headlessKind(runtime.launch.kind, { args: [], headlessArgs: runtime.launch.headlessArgs }) ? `runs ${runtime.name}, which has no one-task launcher` : null;
    if (reason) unlaunchable.push(`${name} ${reason}`);
    return !reason;
  });
  return { launchable, unlaunchable };
}
/** The one line naming the worker accounts not counted, or null when every one can launch; `unlaunchableNext` is what fixes it. */
export const unlaunchableLine = (unlaunchable: readonly string[]) => unlaunchable.length ? `Not counted: ${unlaunchable.join('; ')}.` : null;
export const unlaunchableNext = 'Give the runtime a one-task form with master registry runtime set NAME --headless-arg=ARG --reason REASON';

/**
 * How many worker sessions the install runs at once: the registry worker role's launchable accounts
 * times its concurrency, set with `master workers N`. An install whose registry names no worker
 * role runs one per configured worker profile, as before.
 */
export function workersAllowed(config: Pick<MasterConfig, 'workers'>, registry: WorkerFleet | null | undefined) {
  const role = registry?.roles.find(entry => entry.name === 'worker');
  return role ? roleLimit({ ...role, accounts: workerAccounts(registry!).launchable }) : config.workers.length;
}

/**
 * `value` with `-n` appended inside `limit` characters (GY-3299): a stem too long for the suffix is
 * cut, so the agent name `inspecthoa-hwd-backend-claude-1` grows `inspecthoa-hwd-backend-claude-2`
 * rather than a 33-character `inspecthoa-hwd-backend-claude-1-2` Herdr refuses, and each n still
 * names one profile.
 */
const numbered = (value: string, n: number, limit: number) => `${value.slice(0, limit - `-${n}`.length).replace(/[-_.]+$/, '')}-${n}`;

/**
 * Adds launch profiles until `allowed` exist, each a copy of the first under its own worker
 * identity: `mint` asks the control plane for the identity's token, which is written beside the
 * first profile's credential. Profiles are only ever added, so a lowered limit leaves the spare
 * ones idle and a raised one reuses them. Growth stops at MAX_WORKER_PROFILES profiles of any mode
 * (GY-3292): past it master.json would be unreadable and every cycle would mint another identity.
 * GY-3285's outage: a role allowing accounts × concurrency past that maximum (128 over 8 accounts)
 * grew the file until it would not parse and every cycle failed — so every profile the loop mints
 * is marked `minted` (a file that will not load is repaired by removing the loop's own entries,
 * never the operator's) and `saveWorkerProfile` revalidates the whole file before it is written,
 * refusing a write that would not load back instead of bricking the install.
 */
export async function growWorkerPool(root: string, config: Pick<MasterConfig, 'workers'> & Partial<Pick<MasterConfig, 'credentialFile' | 'repository'>>, allowed: number, mint: (id: string) => Promise<{ token: string }>) {
  // GY-3730: an install with no launch profile needs none: the first worker identity is minted
  // here too, beside the coordinator's credential. A profile names no runtime; the registry
  // account a dispatch selects decides what starts.
  const stem = (config.repository ?? 'graphyard').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const first = config.workers.find(profile => profile.mode === 'launch' && profile.credentialFile)
    ?? (config.credentialFile && allowed > 0 ? { name: 'worker', principal: `${stem}-worker`, agentName: `${stem}-worker`, mode: 'launch' as const, credentialFile: join(dirname(config.credentialFile), 'worker.token'), agentArgs: [], approvals: 'auto' as const, environment: {} } : undefined);
  const added: WorkerProfile[] = [];
  for (let n = config.workers.includes(first as WorkerProfile) ? 2 : 1; first && config.workers.length < MAX_WORKER_PROFILES && config.workers.filter(profile => profile.mode === 'launch').length < allowed; n++) {
    const profile: WorkerProfile = { ...first, name: numbered(first.name, n, 80), principal: numbered(first.principal, n, 200), agentName: numbered(first.agentName, n, sessionNameLimit), minted: true };
    if (config.workers.some(other => other.name === profile.name || other.principal === profile.principal || other.agentName === profile.agentName)) continue;
    profile.credentialFile = join(dirname(first.credentialFile!), `${profile.principal}.token`);
    await atomicPrivateText(profile.credentialFile, (await mint(profile.principal)).token);
    await saveWorkerProfile(root, profile, async () => ({ actor: { id: profile.principal, role: 'worker' } }));
    config.workers.push(profile); added.push(profile);
  }
  return added;
}
