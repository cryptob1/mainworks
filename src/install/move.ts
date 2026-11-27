// `mainworks install move --to HOST` (GY-3318): one command moves an install to another host. It
// checks through the running control plane that nothing is leased, trialled or queued to merge and
// that every file to copy is readable (GY-4043; the sandbox mask file stays behind), stops the loop,
// copies the install files, the credential directory (the operator tokens and the loop's state files beside
// the coordinator token) and every credential file master.json names, copies the main Git repository
// (with its worktree registrations) the checkout and its CLI release copies point at, provisions the merge-trial image
// on the target and rewrites hostId there; only then re-points the registry accounts placed on this
// host, stops the control plane, copies the database and prints what to start. A failure after
// anything was stopped starts it again and points the accounts back. A move over SSH copies with rsync;
// a stand-in directory (--into) copies in process, with no external tool to need. Both stay outside
// any coordination transaction.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { atomicPrivateWrite, readCredentialFile } from '../private-file.js';
import { registryCommand } from '../cli/master-registry.js';
import { readDaemonState } from '../daemon/state.js';
import { masterConfigSchema } from '../master/profiles.js';
import type { AgentRegistry } from '../model/registry.js';
import { publishedSourceImages } from './adapters.js';
import { installDirectory } from './secrets.js';
import { installIdFor } from './types.js';
import { deployUnitOf, readInstallUnits, userUnitDirectory } from './units.js';
import { localUnit } from './local.js';
import { provisionTrialImage, trialImagePlan, trialImageStartCommand } from './trial-image.js';
import { commandFailure, shellQuote, type CommandResult, type RunOptions, type Transport } from './transport.js';
import { persistLoopStateScope } from '../loop-state.js';
import { stateDirectory } from './layout.js';

export interface MoveApi { read(path: string): Promise<any>; write(path: string, data: unknown): Promise<any> }
export interface MoveDependencies {
  /** The config home install directories live under (default ~/.config/graphyard). */
  configHome?: string;
  unitDirectory?: string;
  /** The control plane, as the master's coordinator credential reaches it. */
  api?: MoveApi;
  /** Stops the install's units and server; default runs the stop commands the plan lists. */
  stop?: (commands: string[][]) => Promise<void>;
  /** Starts what the move stopped, when a later step fails; default runs the commands with stop replaced by start. */
  start?: (commands: string[][]) => Promise<void>;
  /** Runs one program; default spawns it and fails on a nonzero exit. */
  run?: (program: string, args: string[]) => Promise<void>;
  /** Docker for the trial image; default runs it on the target — over SSH, deferred to first start for a stand-in directory. */
  transport?: Transport;
}

const run = (program: string, args: string[]) => new Promise<void>((accept, reject) => {
  const child = spawn(program, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? accept() : reject(new Error(`${program} ${args.join(' ')} exited with ${code}: ${error.trim().split('\n').slice(-3).join(' ')}`)));
});

/** Runs one program and captures its output, as the trial-image provisioning needs. */
const capture = (program: string, args: string[], options: RunOptions = {}): Promise<CommandResult> => new Promise(accept => {
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: options.timeout });
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.on('error', error => accept({ stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`, code: 1 }));
  child.on('close', code => accept({ stdout, stderr, code: code ?? 1 }));
});

/** Every `credentialFile` master.json names, wherever it sits (master, operator agent, workers, reviewers, producers, upstream). */
function credentialFiles(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) credentialFiles(entry, found);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    if (key === 'credentialFile' && typeof entry === 'string') found.add(entry); else credentialFiles(entry, found);
  }
  return found;
}

function masterApi(url: string, token: string): MoveApi {
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${url}/api/${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
      .catch(error => { throw new Error(`The control plane at ${url} is unreachable (${error.message}); the move checks leases and re-points accounts through it, so start it and rerun`); });
    const body = await response.json();
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
    return body;
  };
  return { read: path => call(path), write: (path, data) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(data) }) };
}

/** A linked worktree's `.git` names the registration Git keeps for it: `gitdir: <gitdir>/worktrees/<name>`. */
const gitdirPointer = (tree: string): string | null => {
  try {
    const match = /^gitdir: (.+)$/m.exec(readFileSync(join(tree, '.git'), 'utf8'));
    return match ? resolve(match[1].trim()) : null;
  } catch { return null; }
};
/** The main repository a worktree registration belongs to: Git's `commondir` file names it, relative to the registration. */
const commonGitdir = (registration: string): string => {
  try { return resolve(registration, readFileSync(join(registration, 'commondir'), 'utf8').trim()); } catch { return dirname(dirname(registration)); }
};
/**
 * The Git repositories the copy leaves dangling on the target (GY-3317): every copied tree that is
 * a linked worktree — the checkout itself and each CLI release copy under it — points at a
 * `<gitdir>/worktrees/<name>` registration inside its main clone's `.git`, whose objects, refs and
 * config Git needs as well, so the move copies that whole `.git`. A repository already inside a
 * carried directory (a checkout that is its own main repository) went with the copy.
 */
function worktreeRepositories(root: string, carried: string[]): string[] {
  const releases = join(stateDirectory(root), 'cli-releases');
  const trees = [root, ...(existsSync(releases) ? readdirSync(releases, { withFileTypes: true }) : []).filter(entry => entry.isDirectory()).map(entry => join(releases, entry.name))];
  return [...new Set(trees.map(gitdirPointer).filter((entry): entry is string => !!entry && existsSync(entry)).map(commonGitdir))]
    .filter(entry => !carried.some(base => entry === base || entry.startsWith(`${base}/`)));
}

/** A socket, FIFO or device file: nothing a move can copy, and each is recreated by whatever made it. */
const special = (entry: Stats) => !entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink();
/**
 * Every file under PATHS the move cannot read, and every special file it leaves behind, each named
 * once though the trees overlap, SKIP left out: a symbolic link is copied as itself, so it is not followed.
 */
function scanFiles(paths: string[], skip: string[]) {
  const unreadable: string[] = [], skipped: string[] = [];
  const visit = (path: string) => {
    if (skip.includes(path)) return;
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) return;
      if (special(entry)) skipped.push(path);
      else if (entry.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
      else accessSync(path, constants.R_OK);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(path); }
  };
  for (const path of paths) visit(path);
  return { unreadable: [...new Set(unreadable)], skipped: [...new Set(skipped)] };
}

/** Docker commands of the move run on the target: through SSH for a real move, directly for a stand-in directory. */
function targetTransport(to: string, into: string | undefined, exec: (program: string, args: string[]) => Promise<void>): Transport {
  return {
    description: into ? resolve(into) : `${to} over SSH`,
    async exec(program, args, options = {}) {
      const result = into ? await capture(program, args, options) : await capture('ssh', [to, [program, ...args].map(shellQuote).join(' ')], options);
      if (result.code !== 0 && !options.allowFailure) throw commandFailure(program, result);
      return result;
    },
    async putFile(path, content, mode) {
      if (into) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, content, { mode }); return; }
      const scratch = await mkdtemp(join(tmpdir(), 'mainworks-move-'));
      try {
        const staged = join(scratch, basename(path));
        await writeFile(staged, content, { mode });
        await exec('rsync', ['-a', '--mkpath', `--chmod=F${mode.toString(8)}`, staged, `${to}:${path}`]);
      } finally { await rm(scratch, { recursive: true, force: true }); }
    },
  };
}

/** The move of the install whose checkout is ROOT to host TO; `into` writes the target's files under that directory instead of `TO:` over SSH. */
export async function moveInstall(root: string, options: { to: string; into?: string; plan?: boolean }, dependencies: MoveDependencies = {}) {
  root = resolve(root);
  const masterFile = join(stateDirectory(root), 'master.json'), connectionFile = join(stateDirectory(root), 'connection.json');
  const stored = JSON.parse(await readFile(masterFile, 'utf8'));
  const config = masterConfigSchema.parse(stored);
  const from = config.hostId, to = options.to.trim();
  if (!to) throw new Error('Use install move --to HOST [--into DIR] [--plan]');
  if (to === from) throw new Error(`This install is already on ${to}`);
  const installId = installIdFor(config.repository), directory = installDirectory(installId, dependencies.configHome);
  const postgres = join(directory, 'postgres'), local = existsSync(postgres);
  const volume = `graphyard-${installId}_graphyard-data`, volumeArchive = join(directory, 'graphyard-data.tar');
  const database = local ? { kind: 'directory' as const, path: postgres } : { kind: 'volume' as const, volume, archive: volumeArchive };
  // The coordinator token's directory also holds the operator tokens beside it and the loop's
  // daemon state and cursor files, none of which master.json names (~/.config/graphyard/masters).
  const credentialDirectory = dirname(config.credentialFile);
  const carried = [root, directory, ...(credentialDirectory === directory || credentialDirectory.startsWith(`${directory}/`) ? [] : [credentialDirectory])];
  const worktrees = worktreeRepositories(root, carried);
  const directories = [...carried, ...worktrees];
  let units: { master: string; deploy: string } | null = null;
  try { const recorded = readInstallUnits(root, dependencies.unitDirectory); units = { master: recorded.master, deploy: deployUnitOf(recorded) }; } catch { /* no units recorded: nothing to stop or copy */ }
  const unitDirectory = dependencies.unitDirectory ?? userUnitDirectory();
  const unitNames = [...(units ? [units.master, units.deploy] : []), ...(local ? [localUnit(installId)] : [])];
  const unitFiles = unitNames.map(name => join(unitDirectory, name)).filter(file => existsSync(file));
  const files = [...directories, ...unitFiles];
  const credentials = [...credentialFiles(stored)].sort();
  const published = publishedSourceImages(root)?.trial ?? null;
  const trialImage = trialImagePlan({ sourceRoot: root }, published);

  const api = dependencies.api ?? masterApi(config.url, await readCredentialFile(config.credentialFile));
  const { work } = await api.read('work-snapshot') as { work: { key: string; lease?: { owner: string } | null }[] };
  const state = await readDaemonState(root, config).catch(() => null);
  const refusals = [
    ...work.filter(item => item.lease).map(item => `${item.key} is leased to ${item.lease!.owner}`),
    ...(state?.mergeWriter.inFlight ? [`${state.mergeWriter.inFlight.key} is in a merge trial`] : []),
    ...(state?.mergeWriter.queue ?? []).map(entry => `${entry.key} is queued to merge`),
  ];
  const registry = await api.read('agent-registry/document') as AgentRegistry;
  const accounts = registry.accounts.filter(account => account.credential.host === from).map(account => account.name);
  const destination = (path: string) => options.into ? join(resolve(options.into), path) : `${to}:${path}`;
  // A loop unit with no unit file is not installed here, so there is nothing of it to stop.
  const loopStop = (units ? [units.master, units.deploy] : []).filter(name => existsSync(join(unitDirectory, name))).map(name => ['systemctl', '--user', 'stop', name]);
  const planeStop = local ? [['systemctl', '--user', 'stop', localUnit(installId)]] : [['docker', 'compose', '--project-directory', join(directory, 'compose'), 'stop']];
  const stop = [...loopStop, ...planeStop];
  // GY-4043: the sandbox mask file (mode 000) is recreated on first launch, so it stays behind; every other file must be readable before anything changes.
  const stateName = basename(stateDirectory(root)), rootSkipped = [join(stateName, 'worktrees'), join(stateName, 'masked')], databaseFiles = [basename(postgres), basename(volumeArchive)];
  const { unreadable, skipped: specials } = scanFiles([...directories, ...unitFiles, ...credentials], rootSkipped.map(entry => join(root, entry)));
  const skipped = specials.length ? `Left behind ${specials.length} socket, FIFO or device file${specials.length === 1 ? '' : 's'}, which nothing can copy: ${specials.join(', ')}` : null;
  const start = [
    ...(options.into ? [trialImageStartCommand(root)] : []),
    ...(local ? [] : [`docker volume create ${volume}`, `docker run --rm -v ${volume}:/data -v ${directory}:/in postgres:17-alpine tar -C /data -xf /in/graphyard-data.tar`, `docker compose --project-directory ${join(directory, 'compose')} up -d`]),
    ...(unitNames.length ? ['systemctl --user daemon-reload', `systemctl --user enable --now ${unitNames.join(' ')}`] : []),
    `cd ${root} && mainworks master status`,
  ];
  const plan = { from, to, target: options.into ? resolve(options.into) : `${to} over SSH`, database, files, worktrees, credentials, accounts, refusals, unreadable, skipped,
    trialImage: { title: trialImage.title, command: trialImage.command }, stop: stop.map(command => command.join(' ')), start };
  if (options.plan) return { ...plan, applied: false, next: refusals.length ? 'Wait until nothing is leased, trialled or queued, then rerun without --plan' : 'Rerun without --plan to move the install' };
  if (refusals.length) throw new Error(`The install cannot move while work is in flight: ${refusals.join('; ')}`);
  if (unreadable.length) throw new Error(`Nothing was moved: the move cannot read ${unreadable.join(', ')}; make each readable or remove it, then rerun`);

  await persistLoopStateScope(masterFile, stored);
  const reason = `Install moved from ${from} to ${to}`;
  const exec = dependencies.run ?? run;
  const each = (commands: string[][]) => (async () => { for (const [program, ...args] of commands) await exec(program!, args).catch(() => {}); })();
  const stopping = dependencies.stop ?? each, starting = dependencies.start ?? each;
  /** Copies one path to the target: rsync over SSH for a real move, in process for a stand-in directory — no rsync to spawn, so the move runs anywhere (the trial image ships none). */
  const copy = (path: string, extra: { exclude?: string[]; mode?: number; contents?: boolean } = {}) => {
    const exclude = extra.exclude ?? [];
    if (!options.into) return exec('rsync', ['-a', '--no-D', '--mkpath', ...exclude.flatMap(entry => ['--exclude', `/${entry}`]), ...(extra.mode !== undefined ? [`--chmod=F${extra.mode.toString(8)}`] : []), extra.contents ? `${path}/` : path, `${to}:${path}`]);
    const targetPath = join(resolve(options.into), path);
    return (async () => {
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await cp(path, targetPath, { recursive: true, verbatimSymlinks: true, filter: async (candidate: string) => !exclude.some(entry => candidate === join(path, entry)) && !special(await lstat(candidate)) });
      if (extra.mode !== undefined) await chmod(targetPath, extra.mode);
    })();
  };
  // The loop stops first and the control plane last: the accounts are re-pointed through the
  // control plane once every file is on the target, and only then is the database stopped and copied.
  const stopped = new Set<string[][]>(), repointed: string[] = [];
  const stopNow = async (commands: string[][]) => { if (!commands.length) return; stopped.add(commands); await stopping(commands); };
  try {
    await stopNow(loopStop);
    for (const path of directories) await copy(path, { contents: true, exclude: path === root ? rootSkipped : path === directory ? databaseFiles : [] });
    for (const file of unitFiles) await copy(file);
    for (const file of credentials) await copy(file, { mode: 0o600 });
    // hostId names the target in both files the target's CLI and loop read.
    for (const file of [masterFile, connectionFile].filter(existsSync)) {
      const rewritten = { ...JSON.parse(await readFile(file, 'utf8')), hostId: to };
      if (options.into) await atomicPrivateWrite(destination(file), rewritten);
      else {
        const scratch = await mkdtemp(join(tmpdir(), 'mainworks-move-'));
        try {
          const staged = join(scratch, basename(file));
          await atomicPrivateWrite(staged, rewritten);
          await exec('rsync', ['-a', '--mkpath', '--chmod=F600', staged, `${to}:${file}`]);
        } finally { await rm(scratch, { recursive: true, force: true }); }
      }
    }
    // The target's complete submissions and merge trials run in the trial image, so the move leaves it provisioned there (GY-3318).
    if (!options.into) await provisionTrialImage({ transport: dependencies.transport ?? targetTransport(to, undefined, exec), sourceRoot: root }, published);
    for (const name of accounts) { await registryCommand(config, ['account', 'set', name, '--host', to, '--reason', reason], api); repointed.push(name); }
    await stopNow(planeStop);
    if (local) await copy(postgres, { contents: true });
    else {
      await exec('docker', ['run', '--rm', '-v', `${volume}:/data`, '-v', `${directory}:/out`, 'postgres:17-alpine', 'tar', '-C', '/data', '-cf', '/out/graphyard-data.tar', '.']);
      await copy(volumeArchive);
    }
    if (options.into) await writeFile(join(resolve(options.into), 'start.sh'), `#!/bin/sh\nset -e\n${start.join('\n')}\n`, { mode: 0o700 });
  } catch (error) {
    const undone: string[] = [];
    try {
      // The control plane first, so the accounts can be pointed back before the loop dispatches again.
      const restart = async (commands: string[][], what: string) => {
        if (!stopped.has(commands)) return;
        await starting(commands.map(([program, ...args]) => [program!, ...args.map(word => word === 'stop' ? 'start' : word)]));
        undone.push(`started ${what} again`);
      };
      await restart(planeStop, 'the control plane');
      if (repointed.length) {
        // The restarted control plane may take a moment to answer.
        for (let attempt = 1; ; attempt++) {
          try { for (const name of repointed) await registryCommand(config, ['account', 'set', name, '--host', from, '--reason', `Install move to ${to} failed`], api); break; }
          catch (retry) { if (attempt >= 30) throw retry; await new Promise(wait => setTimeout(wait, 1000)); }
        }
        undone.push(`${repointed.join(', ')} point at ${from} again`);
      }
      await restart(loopStop, loopStop.map(command => command.at(-1)).join(', '));
    } catch (undo) {
      throw new Error(`The move to ${to} failed (${(error as Error).message}) and could not be fully undone (${(undo as Error).message})${undone.length ? `; it ${undone.join('; ')}` : ''}`);
    }
    throw new Error(`The move to ${to} failed: ${(error as Error).message}. Undone: ${undone.length ? undone.join('; ') : 'nothing had changed'}; the install still runs on ${from}`);
  }
  return { ...plan, applied: true, next: `On ${to}, run: ${start.join(' && ')}` };
}
