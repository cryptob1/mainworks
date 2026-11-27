// Concern: the deployed environments' variables. The repository's graphyard.json `runtime` names
// what each environment must hold; the install's own runtime.json (mode 0600, beside its
// credentials) holds the commands that list and set them on the platform. The commands never come
// from the repository: a candidate writes graphyard.json, and these run with the platform login.
// Only names are read back: a listed value is dropped unread and no command's output is printed.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { parseRepositoryConfig, runtimeEnvironmentName } from './model-boundary/documentation.js';
import { repositoryConfigFile } from './model/documentation.js';
import { pushInheritedVariables } from './merge-writer/executor.js';
import { COMMAND_NAME } from './model/product.js';

/** One environment's answer: the required names it lacks, or why its listing gave none. */
export interface RuntimeCheck { environment: string; missing: string[]; fault: string | null }
/** Per environment of the install, the command printing the names it holds and the one setting `$NAME` to `$VALUE`. */
const installRuntimeSchema = z.object({
  environments: z.record(runtimeEnvironmentName, z.object({ list: z.string().trim().min(1), set: z.string().trim().min(1) }).strict())
    .refine(environments => Object.keys(environments).length > 0, 'Name at least one environment'),
}).strict();
export type InstallRuntime = z.infer<typeof installRuntimeSchema>;
export const installRuntimeFile = (installDirectory: string) => join(installDirectory, 'runtime.json');

/** The install's runtime commands; a file others may read is refused, as the install's other secrets are. */
export async function readInstallRuntime(installDirectory: string): Promise<InstallRuntime> {
  const file = installRuntimeFile(installDirectory);
  let mode: number;
  try { mode = (await stat(file)).mode; } catch { throw new Error(`No ${file}: write each environment's list and set commands there, mode 0600 (${COMMAND_NAME} master guide)`); }
  if (mode & 0o077) throw new Error(`${file} is readable by others: chmod 600 it`);
  return installRuntimeSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** The names a listing printed: a JSON object's keys, else one per line (`NAME` or `NAME=value`). */
export function listedNames(output: string): Set<string> {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return new Set(Object.keys(parsed));
  } catch { /* not JSON: one name per line */ }
  return new Set(output.split('\n').map(line => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|$)/.exec(line)?.[1]).filter((name): name is string => !!name));
}

export type RunCommand = (command: string, env: Record<string, string>) => Promise<string>;
const exec = promisify(execFile);
/** A command with only the variables a platform CLI needs to find its login (the merge writer's push list) and those given. */
export const runCommand: RunCommand = async (command, env) => {
  const inherited = Object.fromEntries(pushInheritedVariables.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  return (await exec('sh', ['-c', command], { env: { ...inherited, ...env }, timeout: 60_000, maxBuffer: 4 << 20 })).stdout;
};

/** Why a command failed, without its output: stderr may carry a value. */
function commandFault(what: string, error: any): string {
  const how = error?.killed ? 'timed out' : typeof error?.code === 'number' ? `exit ${error.code}` : error?.signal ?? error?.code ?? 'failed to start';
  return `its ${what} command failed (${how}); run it by hand to see why`;
}

/** Checks the named environments (every declared one when none is named): `root`'s graphyard.json says what each needs. */
export async function checkRuntime(root: string, installDirectory: string, names: readonly string[] = [], run: RunCommand = runCommand): Promise<RuntimeCheck[]> {
  let text: string;
  try { text = await readFile(join(root, repositoryConfigFile), 'utf8'); } catch { throw new Error(`No ${repositoryConfigFile} in ${root}: run this in the repository checkout`); }
  const declared = Object.entries(parseRepositoryConfig(text).runtime?.environments ?? {});
  if (!declared.length) throw new Error(`${repositoryConfigFile} declares no runtime environments`);
  const unknown = names.filter(name => !declared.some(([environment]) => environment === name));
  if (unknown.length) throw new Error(`No runtime environment ${unknown.join(', ')}; ${repositoryConfigFile} declares ${declared.map(([environment]) => environment).join(', ')}`);
  const commands = (await readInstallRuntime(installDirectory)).environments;
  return Promise.all(declared.filter(([environment]) => !names.length || names.includes(environment)).map(async ([environment, { required }]) => {
    const command = commands[environment]?.list;
    if (!command) return { environment, missing: [], fault: `${installRuntimeFile(installDirectory)} has no list command for it` };
    try {
      const held = listedNames(await run(command, {}));
      return { environment, missing: required.filter(name => !held.has(name)), fault: null };
    } catch (error) {
      return { environment, missing: [], fault: commandFault('list', error) };
    }
  }));
}

/**
 * Sets `name` to `value` in every environment the install declares, then lists each to confirm it
 * holds the name. The value reaches the set command only as `$VALUE`; no output is kept.
 */
export async function setVariable(installDirectory: string, name: string, value: string, run: RunCommand = runCommand): Promise<{ environments: string[]; error: string | null }> {
  const environments = Object.entries((await readInstallRuntime(installDirectory)).environments), done: string[] = [];
  for (const [environment, { list, set }] of environments) {
    try { await run(set, { NAME: name, VALUE: value }); } catch (error) { return { environments: done, error: `${environment}: ${commandFault('set', error)}` }; }
    let held: Set<string>;
    try { held = listedNames(await run(list, {})); } catch (error) { return { environments: done, error: `${environment}: ${commandFault('list', error)}` }; }
    if (!held.has(name)) return { environments: done, error: `${environment}: its list command does not show ${name} after setting it` };
    done.push(environment);
  }
  return { environments: done, error: null };
}
