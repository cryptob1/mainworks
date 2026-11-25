import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetLaunchAccount } from '../fleet.js';
import { defaultPiModel, piSmoke, type SmokeResult } from './pi.js';
import { piKeyEnvironment, runConfinement } from './roles.js';
import { accountLaunch, type LaunchAccount } from '../master/environments.js';
import { credentialMaskFor } from '../master/confinement.js';
import { runtimeLoginHomes } from '../master/profiles.js';

/**
 * A worker session's launch on the chosen account, whatever worker identity claims the item: the
 * account's runtime, its login home on the runtime's home variable (kept readable through the
 * credential mask), and a Pi account's key. Dispatch launches this and the worker-role smoke of a
 * Pi account runs it, so the check that passes is the launch that runs.
 */
export async function workerSessionLaunch(config: Parameters<typeof credentialMaskFor>[0], profile: Parameters<typeof accountLaunch>[0] & { credentialFile?: string | null }, account: LaunchAccount | null, reach: { repositoryRoot?: string } = {}) {
  const launch = accountLaunch(profile, account, { ...reach, headless: true });
  const modelId = account && 'fleet' in account ? account.fleet.modelId : null;
  const environment = { ...launch.environment, ...(launch.kind === 'pi' ? await piKeyEnvironment(launch.home, modelId) : {}) };
  const credentialMask = credentialMaskFor(config, { credentialFile: profile.credentialFile, runtimeHomes: runtimeLoginHomes(environment, launch.contract?.homeVariable, launch.kind) });
  return { ...launch, environment, credentialMask };
}

/**
 * The worker-role smoke of a Pi account (GY-3721, GY-3738): one prompt on the launch dispatch would
 * start — its environment and key from workerSessionLaunch, inside the same sandbox and credential
 * mask — so an account whose worker launch would fail is refused the role.
 */
export async function smokePiWorker(config: Parameters<typeof credentialMaskFor>[0], account: FleetLaunchAccount): Promise<SmokeResult> {
  let launch: Awaited<ReturnType<typeof workerSessionLaunch>>;
  try { launch = await workerSessionLaunch(config, { kind: 'pi', approvals: 'auto', agentArgs: [], environment: {} }, account); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  const cwd = mkdtempSync(join(tmpdir(), 'mainworks-pi-smoke-'));
  try {
    const wrapper = runConfinement({ credentialMask: launch.credentialMask })?.(cwd, launch.environment) ?? [];
    const command = launch.contract?.kind ?? 'pi', redact = Object.entries(launch.environment).filter(([name]) => name.endsWith('_API_KEY')).map(([, value]) => value);
    return await piSmoke({ command: wrapper[0] ?? command, commandArgs: wrapper.length ? [...wrapper.slice(1), command] : [], model: account.fleet.modelId ?? defaultPiModel, environment: launch.environment }, { cwd, redact });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
