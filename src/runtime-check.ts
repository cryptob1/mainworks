// Concern: the deployed environments' variables (graphyard.json `runtime`). Each environment's
// `variables` command prints the names it holds; the check names the required ones it lacks, so a
// promotion stops before production runs without a secret staging had. Only names are read: a
// listed value is dropped unread and the command's output is never printed.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseRepositoryConfig } from './model-boundary/documentation.js';
import { repositoryConfigFile } from './model/documentation.js';

/** One environment's answer: the required names it lacks, or why its listing gave none. */
export interface RuntimeCheck { environment: string; missing: string[]; fault: string | null }

/** The names a listing printed: a JSON object's keys, else one per line (`NAME` or `NAME=value`). */
export function listedNames(output: string): Set<string> {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return new Set(Object.keys(parsed));
  } catch { /* not JSON: one name per line */ }
  return new Set(output.split('\n').map(line => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|$)/.exec(line)?.[1]).filter((name): name is string => !!name));
}

const exec = promisify(execFile);
/** Runs a `variables` command in the checkout with the caller's own environment (its platform login). */
async function listVariables(command: string, cwd: string): Promise<string> {
  return (await exec('sh', ['-c', command], { cwd, timeout: 60_000, maxBuffer: 4 << 20 })).stdout;
}

/** Why a listing failed, without its output: stderr may carry a value. */
function listingFault(error: any): string {
  const how = error?.killed ? 'timed out' : typeof error?.code === 'number' ? `exit ${error.code}` : error?.signal ?? error?.code ?? 'failed to start';
  return `its variables command failed (${how}); run it by hand to see why`;
}

/** Checks the named environments (every declared one when none is named) against `root`'s graphyard.json. */
export async function checkRuntime(root: string, names: readonly string[] = [], run = listVariables): Promise<RuntimeCheck[]> {
  let text: string;
  try { text = await readFile(join(root, repositoryConfigFile), 'utf8'); } catch { throw new Error(`No ${repositoryConfigFile} in ${root}: run this in the repository checkout`); }
  const declared = Object.entries(parseRepositoryConfig(text).runtime?.environments ?? {});
  if (!declared.length) throw new Error(`${repositoryConfigFile} declares no runtime environments`);
  const unknown = names.filter(name => !declared.some(([environment]) => environment === name));
  if (unknown.length) throw new Error(`No runtime environment ${unknown.join(', ')}; ${repositoryConfigFile} declares ${declared.map(([environment]) => environment).join(', ')}`);
  return Promise.all(declared.filter(([environment]) => !names.length || names.includes(environment)).map(async ([environment, { variables, required }]) => {
    try {
      const held = listedNames(await run(variables, root));
      return { environment, missing: required.filter(name => !held.has(name)), fault: null };
    } catch (error) {
      return { environment, missing: [], fault: listingFault(error) };
    }
  }));
}
