import { headlessArgv } from '../headless-argv.js';
import { ChildProcessError, runChild } from '../child-runner.js';
import { randomUUID } from 'node:crypto';
import { confinedRuntimeArgs } from '../worker-sandbox.js';
import { spawn, type SpawnOptions } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultPiModel, piRunner, piSmoke, runEnvironment, type SmokeResult } from './pi.js';
import { headlessConfinementWrapper, launcherCoordinatorRoot } from '../master/launch.js';
import { bwrapOnPath, type CredentialMask } from '../master/confinement.js';
import { accountHomeEnvironment, withModel } from '../master/runtimes.js';
import type { FleetLaunchAccount } from '../fleet.js';
import { registryToolsArgs } from '../registry-tools.js';
import { claimRunWatch, liveRun, runsDirectory, superviseRun, writeRunOwner, type Applied } from './registry.js';
import { evidencePayloadSchema, mainworksTools, piRuntimeSchema, type EvidencePayload } from './payloads.js';
import { runRecord, type RunOptions, type RunRecord, type RunResult, type Runner } from './types.js';
import { parseProbeFailure } from '../model/account-quota.js';

/**
 * A child-process spawner that puts the coordinator confinement (GY-888) before a spawned command:
 * the bubblewrap words go before the command and its arguments, which keep their own working
 * directory, environment and streams. A spawn that cannot be confined throws instead of starting
 * unconfined. Headless runs are not spawned through it: their runner confines Pi alone, inside the
 * run's shell (`runConfinement`).
 */
export function confiningSpawn(base: typeof spawn = spawn, options: { coordinatorRoot?: string | null; bwrap?: string | null } = {}): typeof spawn {
  const confine = runConfinement(options);
  if (!confine) return base;
  return ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    const wrapper = confine(typeof spawnOptions?.cwd === 'string' ? spawnOptions.cwd : undefined, spawnOptions.env ?? process.env);
    return base(wrapper[0], [...wrapper.slice(1), command, ...confinedRuntimeArgs(command, args)], spawnOptions);
  }) as typeof spawn;
}

/**
 * The coordinator confinement of every headless run (GY-888), as the runner's `confine` option:
 * the launcher's headless roles (a `pi` producer run) start their runtime with no pane
 * command line to carry the wrapper, so the runner puts the bubblewrap words before Pi's command
 * itself, inside the run's shell (GY-453). The shell stays outside, because it writes the run's
 * output and exit to its directory under the coordinator checkout, which the confinement binds
 * read-only; and a run's transient scope stays outermost, because the confinement masks the user
 * bus a `systemd-run` needs. A run that cannot be confined throws here, so it fails instead of
 * starting unconfined. A `credentialMask` hides the install's credential locations from the run
 * (GY-1856), with the run's own kept.
 */
export function runConfinement(options: { coordinatorRoot?: string | null; bwrap?: string | null; credentialMask?: CredentialMask } = {}): ((cwd: string | undefined, environment: NodeJS.ProcessEnv) => readonly string[]) | undefined {
  const root = options.coordinatorRoot !== undefined ? options.coordinatorRoot : launcherCoordinatorRoot();
  if (!root) return undefined;
  return (cwd, environment) => headlessConfinementWrapper(root, cwd, options.bwrap !== undefined ? options.bwrap : bwrapOnPath(), options.credentialMask, environment);
}

/**
 * The narrow role on the headless runner (GY-169): the unit proof producer. A run's submission is
 * applied by the loop through the route a terminal session would have used, `evidence` as the
 * producer principal, so the server trusts evidence by the producer's grants and the exercise rule,
 * never by what the run says.
 */

export function narrowRunner(pi: unknown, credentialMask?: CredentialMask, coordinatorRoot?: string): Runner {
  const configured = piRuntimeSchema.parse(pi ?? {});
  // Every headless run is confined at its spawn (GY-888): the checkout the launcher runs from is
  // unwritable to the run, shell commands included, exactly as for a pane session.
  return piRunner({ command: configured.command, model: configured.model, confine: runConfinement({ credentialMask, coordinatorRoot }) });
}

/**
 * A narrow role's headless run on the account the agent registry chose for it (GY-170): the
 * runtime's executable, the account's login home on the runtime's home variable, the model the
 * choice names, and the role policy's flags and tool allowlist — all from the registry revision the
 * choice was made in, never from `run.pi`, which configures only a role the registry does not define.
 * A policy that limits tools on a runtime with no tools flag is refused, as the Herdr path refuses it.
 */
export function registryHeadlessLaunch(account: FleetLaunchAccount) {
  const { contract, policy, modelId } = account.fleet;
  // The model is named once, by the runner, from the registry's id (GY-3687): no alias the contract or policy carries.
  const args = [...withModel(account.kind, [...contract.args, ...(policy?.args ?? [])], contract, null), ...registryToolsArgs(account)];
  // GY-3329: a cursor account's home rides on XDG_CONFIG_HOME as well, the sign-in
  // cursor-agent reads under confinement living at `$XDG_CONFIG_HOME/cursor/auth.json`.
  const environment: Record<string, string> = { ...contract.environment, ...(contract.homeVariable && account.home ? { [contract.homeVariable]: account.home } : {}), ...accountHomeEnvironment(account.kind, account.home) };
  return { command: contract.kind, model: modelId ?? defaultPiModel, args, environment };
}
/**
 * The provider key an account's registry entry names by reference (GY-446), read from its file in
 * the account's login home at the moment a run starts, as the one variable the runtime reads. The
 * file must be a regular file of mode 0600; its content appears in no error, record or log.
 */
export function accountKeyEnvironment(account: Pick<FleetLaunchAccount, 'name' | 'home' | 'key'>): Record<string, string> {
  if (!account.key) return {};
  if (!account.home) throw new Error(`${account.name} names key file ${account.key.file} but no login home to read it from`);
  const file = resolve(account.home, account.key.file);
  let value: string;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.mode & 0o077) throw new Error(`${file} must be a regular file with mode 0600 (chmod 600 ${file})`);
    value = readFileSync(file, 'utf8').trim();
  } catch (error) { throw new Error(`${account.name}'s key file cannot be read: ${error instanceof Error ? error.message.replace(/^ENOENT: /, '') : 'unreadable'}`); }
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${account.name}'s key file ${file} must hold the key alone, on one line`);
  return { [account.key.variable]: value };
}
/** A registry account's headless runner: every run reads the account's key afresh, into its own environment only, and every run is confined at its spawn (GY-888). Extra arguments after the account's own narrow the session further (the doctor's tool set). */
export function registryRunner(account: FleetLaunchAccount, extraArgs: string[] = [], credentialMask?: CredentialMask, coordinatorRoot?: string): Runner {
  const launch = registryHeadlessLaunch(account);
  return { name: 'pi', start: (prompt, options) => piRunner({ command: launch.command, model: launch.model, args: [...launch.args, ...extraArgs], environment: { ...launch.environment, ...accountKeyEnvironment(account) }, confine: runConfinement({ credentialMask, coordinatorRoot }) }).start(prompt, options) };
}
/** The JSON events in a print-mode run's output that report a failure. */
const failureEvents = (output: string) => output.split('\n').flatMap(line => {
  try { const event = JSON.parse(line); return event && (event.type === 'error' || event.type === 'turn.failed' || event.is_error === true || !!event.api_error) ? [event] : []; } catch { return []; }
});
/** OpenCode's run banner, naming the agent and the model that answers: `build · big-pickle`. */
const wrongModelBanner = /\b(?:build|plan) · (\S+)/;
/**
 * GY-3592: OpenCode did not run the account's plan model: its free-tier refusal, or a run banner naming
 * another model, for a model with its own provider. The plan's allowance was never asked, so it is no limit.
 */
export function planModelUnused(output: string, modelId: string | null | undefined) {
  if (!modelId || !/^(?!opencode\/)[^/]+\//.test(modelId)) return false;
  const ran = wrongModelBanner.exec(output)?.[1];
  return /\bfree usage limit reached\b|\bFreeUsageLimitError\b/i.test(output) || !!ran && ran !== modelId && ran !== modelId.split('/').pop();
}
/**
 * The one-prompt smoke test of a registry account (GY-446): its runtime, login home, key and model,
 * none of a role's policy. A key file that cannot be read fails the test with that reason.
 */
export async function smokeRegistryAccount(account: FleetLaunchAccount, options: { cwd?: string; timeoutMs?: number; command?: string; commandArgs?: string[] } = {}): Promise<SmokeResult> {
  if (account.kind === 'agy') return agySmoke(account, options);
  const launch = registryHeadlessLaunch({ ...account, fleet: { ...account.fleet, policy: undefined } });
  let key: Record<string, string>;
  try { key = accountKeyEnvironment(account); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  if (account.kind !== 'pi') {
    const env = runEnvironment(process.env, { ...launch.environment, ...key });
    try {
      // GY-3592: `opencode run` takes --model though its contract names no flag (the TUI refuses it); unnamed, OpenCode answers on its free model.
      const args = withModel(account.kind, launch.args, account.fleet.contract, account.fleet.modelId);
      const [command, ...argv] = await headlessArgv({ kind: account.kind, args, contract: account.fleet.contract }, 'Reply with the single word OK.', env);
      const output = await runChild(options.command ?? command, [...(options.commandArgs ?? []), ...argv], { env, cwd: options.cwd ?? account.home ?? undefined, timeoutMs: options.timeoutMs ?? 120_000 });
      // Print-mode runtimes can report provider errors with exit zero (OpenCode).
      const failure = failureEvents(output).length > 0;
      const answered = /\bOK\b/i.test(output);
      if (answered && !failure && planModelUnused(output, account.fleet.modelId)) return { ok: false, error: wrongModelBanner.exec(output)![0] };
      return { output, ok: answered && !failure, error: failure ? Object.values(key).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), parseProbeFailure(output).reason) : answered ? null : 'The smoke request returned no answer' };
    } catch (error) {
      const message = error instanceof ChildProcessError ? [error.stdout, error.stderr].filter(Boolean).join('\n') || error.message : String(error);
      return { ok: false, error: Object.values(key).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), parseProbeFailure(message).reason) };
    }
  }
  return piSmoke({ command: options.command ?? launch.command, commandArgs: options.commandArgs, model: launch.model, args: launch.args, environment: { ...launch.environment, ...key } },
    { cwd: options.cwd ?? account.home ?? undefined, timeoutMs: options.timeoutMs, redact: Object.values(key) });
}
/**
 * The agy account's smoke test (GY-3108): one print-mode prompt on the account's login, which agy
 * reads only from `$HOME/.gemini/antigravity-cli`, so the run's HOME is a fresh directory that
 * links there. It passes only when agy answers; a run that starts but never answers — waiting at a
 * login, or silent — fails at the bound, as a session that never acts would hold its slot.
 * The scratch HOME is the account's own, cleared before the run, so a home an interrupted test left
 * behind is never reused, and removed after it, pass or fail (GY-3338). A failure that names the
 * scratch HOME is the harness's, said so, not the account's login.
 */
export function agySmoke(account: Pick<FleetLaunchAccount, 'name' | 'home' | 'fleet'>, options: { cwd?: string; timeoutMs?: number; command?: string } = {}): Promise<SmokeResult> {
  const timeoutMs = options.timeoutMs ?? 120_000, command = options.command ?? account.fleet.contract.kind;
  const home = join(tmpdir(), `mainworks-agy-smoke-${account.name.replace(/[^A-Za-z0-9._-]/g, '_')}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home);
  if (account.home) { mkdirSync(join(home, '.gemini')); symlinkSync(resolve(account.home), join(home, '.gemini', 'antigravity-cli')); }
  const model = withModel('agy', [], account.fleet.contract, account.fleet.modelId);
  return new Promise<SmokeResult>(settle => {
    let output = '';
    const child = spawn(command, [...model, '--print', 'Reply with the single word OK.'], { cwd: options.cwd ?? home, env: { ...process.env, ...account.fleet.contract.environment, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const bound = setTimeout(() => { child.kill('SIGKILL'); settle({ ok: false, error: `${command} started but gave no answer within ${Math.round(timeoutMs / 1000)}s${/authentication/i.test(output) ? ': it is waiting for a login' : ''}` }); }, timeoutMs);
    child.stdout!.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.stderr!.on('data', chunk => { output = (output + chunk).slice(-4000); });
    child.on('error', error => { clearTimeout(bound); settle({ ok: false, error: `${command} could not be started: ${error.message}` }); });
    child.on('close', code => {
      clearTimeout(bound);
      const error = output.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `${command} exited with code ${code} without answering`;
      settle(code === 0 && /\bOK\b/.test(output) ? { ok: true, error: null } : { ok: false, error: output.includes(home) ? `the smoke test's scratch home ${home} failed, not the account's login: ${error}` : error });
    });
  }).finally(() => rmSync(home, { recursive: true, force: true }));
}
/**
 * How a headless run ended, as the registry counts it (GY-446): with a result, without one, or —
 * for a run the loop itself cancelled — not the account's doing, so not counted.
 */
export const runOutcome = (record: RunRecord): 'result' | 'no-result' | undefined =>
  record.result?.ok ? 'result' : record.result?.reason === 'cancelled' ? undefined : 'no-result';

export type { Applied } from './registry.js';
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Start a run for one role session, registered under its session name so the loop's supervision
 * sees it, and apply its submission when it ends. `settled` resolves to the record the session
 * keeps: the run's last events, its result, and what became of each submission.
 *
 * With the loop's `root` (GY-453) the run is recorded in the run registry on disk with its owner
 * and the `context` its role needs to apply the result, so a restart that leaves the run going
 * (it is detached) is followed by an adoption that applies it — once, whichever process sees it end.
 */
export function startNarrowRun<T>(input: { runner: Runner; name: string; role: 'producer'; work: string; subject: string; prompt: string; options: RunOptions<T>; checkout?: string;
  apply: (result: RunResult<T>) => Promise<Applied[]>; root?: string; context?: Record<string, unknown> }) {
  const live = liveRun(input.name);
  if (live) throw new Error(`A ${live.role} run named ${input.name} is already running for ${live.work}`);
  const startedAt = new Date().toISOString();
  const run = input.runner.start(input.prompt, input.root ? { ...input.options, runs: runsDirectory(input.root) } : input.options);
  if (run.directory) {
    // Watched here from its start, so no adopter elsewhere takes it once its owner is on disk.
    try { claimRunWatch(run.directory); writeRunOwner(run.directory, { name: input.name, role: input.role, work: input.work, subject: input.subject, context: input.context ?? {}, startedAt }); }
    catch { /* the run is still watched here; only its adoption after a restart is lost */ }
  }
  const settled = superviseRun({ runner: input.runner, run, name: input.name, role: input.role, work: input.work, subject: input.subject, startedAt, apply: input.apply, ...(input.checkout ? { checkout: input.checkout } : {}) });
  return { run, settled, record: runRecord(input.runner.name, run, null, startedAt, null) };
}

async function post(url: string, token: string, path: string, body: unknown, fetcher: typeof fetch) {
  const response = await fetcher(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`Mainworks refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
  return result;
}

/** One proof's result, submitted as the producer principal on the route `mainworks evidence` uses. */
export async function submitEvidence(url: string, token: string, work: { id: string }, payload: EvidencePayload, environment: string, fetcher: typeof fetch = fetch): Promise<Applied> {
  const subject = `proof ${payload.proof}`;
  try {
    await post(url, token, `work/${encodeURIComponent(work.id)}/evidence`, { ...payload, environment: payload.environment ?? environment.slice(0, 100) }, fetcher);
    return { subject, outcome: 'applied', detail: `${payload.result} (${payload.executed} executed, ${payload.skipped} skipped; exercise ${payload.exercise.result})` };
  } catch (error) { return { subject, outcome: 'refused', detail: failure(error) }; }
}

/** The producer's run options: each submission must be one of its proofs on its exact binding. */
export const producerRunOptions = (cwd: string, binding: { sha: string; baseSha: string; policyRevision: number; proofs: string[] }, env: Record<string, string>, timeoutMs: number): RunOptions<EvidencePayload> => ({
  cwd, env: { ...env, GRAPHYARD_PI_ROLE: 'producer' }, tool: mainworksTools.evidence, timeoutMs,
  validate: payload => {
    const parsed = evidencePayloadSchema.parse(payload);
    if (!binding.proofs.includes(parsed.proof)) throw new Error(`${parsed.proof} is not a proof of this request (${binding.proofs.join(', ')})`);
    if (parsed.sha.toLowerCase() !== binding.sha.toLowerCase() || parsed.baseSha.toLowerCase() !== binding.baseSha.toLowerCase() || parsed.policyRevision !== binding.policyRevision)
      throw new Error(`${parsed.proof} was submitted for ${parsed.sha.slice(0, 12)} on ${parsed.baseSha.slice(0, 12)} under policy ${parsed.policyRevision}, not the requested binding`);
    return parsed;
  },
});

/**
 * The one definition of a live-install proof (GY-1170): a manual proof that installs Mainworks
 * onto a real Hetzner server. The match is keyed to Hetzner and fails closed (GY-1204): only
 * manual:host-install-live, the host install that provisions a Hetzner server, and a
 * `manual:…install…-live` name carrying a `hetzner` segment (manual:install-hetzner-live) count.
 * A live proof for any other provider (railway, docker-host, compose) is not one, so it is never
 * refused for want of HCLOUD_TOKEN nor handed Hetzner credentials or instructions. The producer's
 * .env allowlist, its launch refusal and the instructions its session reads all follow from this
 * match, so a new live-install proof cannot get the instructions without the credential, or neither.
 */
export const liveInstallProof = (proof: string) => proof === 'manual:host-install-live'
  || (/^manual:(?:[a-z0-9-]+-)?install(?:-[a-z0-9-]+)?-live$/.test(proof) && /[:-]hetzner-/.test(proof));
/** The .env names a live-install session cannot run without; a launch on a host lacking one is refused. */
export const liveInstallRequiredEnv = ['HCLOUD_TOKEN', 'HETZNER_SPEND_CAP_USD_MONTHLY'] as const;
/**
 * The .env name of an SSH key already registered in the Hetzner project (GY-1170). It is passed
 * when set and is never required: without it the session registers a throwaway key itself.
 */
export const liveInstallSshKeyEnv = 'HETZNER_SSH_KEY';
/**
 * What a producer session whose proofs include a live-install proof is told about its Hetzner
 * credential and SSH key; empty for every other session.
 */
export function liveInstallGuidance(proofs: readonly string[], directory: string, key: string, sha: string) {
  if (!proofs.some(liveInstallProof)) return '';
  const name = `graphyard-${key.toLowerCase()}-${sha.slice(0, 8)}`, file = `${directory}/hetzner-ssh-key`;
  return `For the live install proofs (${proofs.filter(liveInstallProof).join(', ')}), ${liveInstallRequiredEnv.join(' and ')} are available in your environment; stay under the cap. `
    + `If ${liveInstallSshKeyEnv} is set in your environment, pass --ssh-key "$${liveInstallSshKeyEnv}"; otherwise ssh-keygen -t ed25519 -N '' -C ${name} -f ${file}, hcloud ssh-key create --name ${name} --public-key-from-file ${file}.pub, and pass --ssh-key ${name}. `
    + `Pass or fail, delete every server, volume and key you created (hcloud ssh-key delete ${name}). `;
}

