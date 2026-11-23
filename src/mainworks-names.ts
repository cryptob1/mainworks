// GY-3573: Graphyard is now Mainworks. Every setting is read as MAINWORKS_X, falling back to
// GRAPHYARD_X; every path uses the mainworks name on a fresh install or where it exists, else the
// graphyard one an existing install already has. Nothing is migrated or moved.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one helper every setting goes through: MAINWORKS_<NAME>, else GRAPHYARD_<NAME>. It only reads;
 * the environment is never rewritten, so child processes inherit it as it is.
 */
export const setting = (name: string, env: Record<string, string | undefined> = process.env) => env[`MAINWORKS_${name}`] ?? env[`GRAPHYARD_${name}`];

/** The mainworks name under PARENT when it exists or the graphyard one does not, else the graphyard one. */
export const mainworksOr = (parent: string, mainworks: string, graphyard: string) =>
  join(parent, existsSync(join(parent, mainworks)) || !existsSync(join(parent, graphyard)) ? mainworks : graphyard);
/**
 * A checkout's local state directory: `.mainworks`, or `.graphyard` where an existing install has
 * one or its `.gitignore` names only `.graphyard` (a fresh clone or worktree of an existing install).
 */
export function stateDir(root: string) {
  if (existsSync(join(root, '.mainworks')) || existsSync(join(root, '.graphyard'))) return mainworksOr(root, '.mainworks', '.graphyard');
  let ignore = ''; try { ignore = readFileSync(join(root, '.gitignore'), 'utf8'); } catch { /* none */ }
  return join(root, /^\/?\.graphyard\/?$/m.test(ignore) && !/^\/?\.mainworks\/?$/m.test(ignore) ? '.graphyard' : '.mainworks');
}
