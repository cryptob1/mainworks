// GY-3573: Graphyard is now Mainworks. Every setting is read as MAINWORKS_X, falling back to
// GRAPHYARD_X; every path uses the mainworks name on a fresh install or where it exists, else the
// graphyard one an existing install already has. Nothing is migrated or moved.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one helper every setting goes through: each MAINWORKS_X moves onto GRAPHYARD_X at process
 * start, the new name winning, so every reader of GRAPHYARD_X honours it and a child process this
 * one sets GRAPHYARD_X for never sees a stale MAINWORKS_X.
 */
export function honourMainworksNames(env: NodeJS.ProcessEnv = process.env) {
  for (const [name, value] of Object.entries(env)) if (name.startsWith('MAINWORKS_')) { if (value !== undefined) env[`GRAPHYARD_${name.slice('MAINWORKS_'.length)}`] = value; delete env[name]; }
  return env;
}
honourMainworksNames();

/** The mainworks name under PARENT when it exists or the graphyard one does not, else the graphyard one. */
export const mainworksOr = (parent: string, mainworks: string, graphyard: string) =>
  join(parent, existsSync(join(parent, mainworks)) || !existsSync(join(parent, graphyard)) ? mainworks : graphyard);
/** A checkout's local state directory: `.mainworks`, or `.graphyard` where an existing install has one. */
export const stateDir = (root: string) => mainworksOr(root, '.mainworks', '.graphyard');
