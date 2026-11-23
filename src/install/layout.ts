// GY-3711: Graphyard is now Mainworks. The names are chosen once, at install, from what exists: an
// install that already has the Graphyard layout keeps it unchanged; a fresh one takes the Mainworks
// names. Every reader asks these helpers, which only look at what the install created.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { setting } from '../setting.js';

/** A checkout's own state directory: `.mainworks` once a fresh install chose it, else `.graphyard`. */
export function stateDirectory(root: string) {
  const fresh = resolve(root, '.mainworks');
  return existsSync(fresh) ? fresh : resolve(root, '.graphyard');
}
/** The default config home: `~/.config/mainworks` once a fresh install chose it, else `~/.config/graphyard`. */
export function defaultConfigHome(home = homedir()) {
  const fresh = resolve(home, '.config', 'mainworks');
  return existsSync(fresh) ? fresh : resolve(home, '.config', 'graphyard');
}
export type UnitPrefix = 'mainworks' | 'graphyard';
/** The prefix of the units the install at ROOT names: `mainworks-*` for a fresh install, `graphyard-*` otherwise. */
export const unitPrefix = (root: string): UnitPrefix => basename(stateDirectory(root)) === '.mainworks' ? 'mainworks' : 'graphyard';
/** The prefix of host units named by install id alone (the local provider's server), from the config home the install chose. */
export const configUnitPrefix = (home = homedir()): UnitPrefix => !setting('CONFIG_HOME') && basename(defaultConfigHome(home)) === 'mainworks' ? 'mainworks' : 'graphyard';

/**
 * The one install-time choice: a checkout with no `.graphyard` gets `.mainworks`, and a home with no
 * `~/.config/graphyard` gets `~/.config/mainworks` (unless a config home is set). Nothing is moved.
 */
export function chooseInstallLayout(root: string | null, home = homedir()) {
  if (root && !existsSync(resolve(root, '.graphyard'))) mkdirSync(resolve(root, '.mainworks'), { recursive: true, mode: 0o700 });
  if (!setting('CONFIG_HOME') && !existsSync(resolve(home, '.config', 'graphyard'))) mkdirSync(resolve(home, '.config', 'mainworks'), { recursive: true, mode: 0o700 });
}
