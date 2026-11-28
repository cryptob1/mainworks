// Concern: GY-4121 — a launch step that failed for a cause of the host (a missing tool, a permission
// refused, a network unreachable) is the operator's to fix: one cause, one fix line, retries paused.
import { accessSync, constants, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { hostname } from 'node:os';

export interface HostCause { key: string; tool: string | null; fix: string }

/** The host cause a failed step's message names, or null when the failure is not the host's. */
export function hostCause(text: string): HostCause | null {
  const host = hostname();
  const tool = /spawn (\S+) ENOENT/.exec(text)?.[1] ?? /command not found: (\S+)/.exec(text)?.[1] ?? /([\w./-]+): command not found/.exec(text)?.[1] ?? /sh: \d+: (\S+): not found/.exec(text)?.[1];
  if (tool) { const name = basename(tool); return { key: `missing tool ${name}`, tool, fix: `Install ${name} on ${host} so the loop's PATH finds it` }; }
  const denied = /(?:EACCES|EPERM)[^']*'(\/[^']+)'/.exec(text)?.[1] ?? /(\/[^\s:'"]+): Permission denied/.exec(text)?.[1];
  if (denied) return { key: `permission denied on ${denied}`, tool: null, fix: `Give the loop's user on ${host} access to ${denied}` };
  const network = /(?:ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN) (\S+)/.exec(text)?.[1];
  if (network) return { key: `network unreachable to ${network}`, tool: null, fix: `Restore ${host}'s network route to ${network}` };
  return null;
}

const executable = (file: string) => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };
/** Whether TOOL (a path, or a name on this process's PATH) is there: the host change that lifts a missing-tool cause. */
export const toolPresent = (tool: string, path = process.env.PATH ?? '') =>
  tool.includes('/') ? executable(tool) : path.split(delimiter).filter(Boolean).some(directory => executable(join(directory, tool)));

/** When the operator last cleared every standing host cause (`master host-causes clear`), or null. */
export function hostCausesClearedAt(file: string): number | null {
  try { const at = Date.parse(readFileSync(file, 'utf8').trim()); return Number.isFinite(at) ? at : null; } catch { return null; }
}
