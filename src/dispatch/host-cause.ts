// Concern: GY-4121 — a launch step that failed for a cause of the host (a missing tool, a permission
// refused, a network unreachable) is the operator's to fix: one cause, one fix line, retries paused.
import { accessSync, constants, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { hostname } from 'node:os';
import type { DispatchCursor, DispatchFailure } from './cursor.js';

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

/** The standing host cause a request's refusal named; while it stands the request is not retried. */
export const heldByHost = (cursor: DispatchCursor, requestId: string) => { const key = cursor.failures[requestId]?.hostCause; return key ? cursor.hostCauses[key] : undefined; };

/** Records the host cause a refusal names on it and the cursor; returns the alert text when the cause is new and not yet alerted. */
export function recordHostCause(cursor: DispatchCursor, failure: DispatchFailure, subject: string): string | null {
  const cause = hostCause(failure.reason);
  if (!cause) return null;
  failure.hostCause = cause.key;
  if (cursor.hostCauses[cause.key]) return null;
  cursor.hostCauses[cause.key] = { tool: cause.tool, fix: cause.fix, detail: failure.reason, at: failure.at };
  // One alert per cause until the operator clears them, so a cause that lifts and returns every cycle alerts once.
  if (cursor.hostCausesAlerted.includes(cause.key)) return null;
  cursor.hostCausesAlerted = [...cursor.hostCausesAlerted, cause.key].slice(-100);
  return `${subject.replace('%s', cause.key)}. Fix: ${cause.fix}`;
}

/** Lifts each cause whose tool is now present or that the operator cleared after it was recorded; its refusals then retry at once. */
export function liftHostCauses(cursor: DispatchCursor, clearedAt: number | null) {
  for (const [key, cause] of Object.entries(cursor.hostCauses)) {
    const cleared = clearedAt !== null && clearedAt >= Date.parse(cause.at);
    if (!cleared && !(cause.tool && toolPresent(cause.tool))) continue;
    delete cursor.hostCauses[key];
    if (cleared) cursor.hostCausesAlerted = [];
    for (const [id, failure] of Object.entries(cursor.failures)) if (failure.hostCause === key) delete cursor.failures[id];
  }
}

/** Drops causes no remaining refusal names: every item they blocked has moved on. */
export function pruneHostCauses(cursor: DispatchCursor) {
  for (const key of Object.keys(cursor.hostCauses)) if (!Object.values(cursor.failures).some(failure => failure.hostCause === key)) delete cursor.hostCauses[key];
}
