import { gitWatchPorts } from '../../src/cli/upgrade.js';
import { defaultChildRun } from '../../src/child-runner.js';
import type { DeployWatchPorts } from '../../src/deploy-watch.js';

const served = (commit: string | (() => string | Promise<string>)) => async () => typeof commit === 'function' ? commit() : commit;

/**
 * Deploy-watch ports for a test: `tip` is the commit the base serves and `head` the one served
 * before it, each a value or read on every call. Every other step succeeds and changes nothing
 * (schema and database both at generation 1, so nothing migrates); a test names only what its case varies.
 */
export function deployPorts(tip: string | (() => string | Promise<string>), head: string | (() => string | Promise<string>), ports: Partial<DeployWatchPorts> = {}): DeployWatchPorts {
  return { fetch: served(tip), head: served(head), checkout: async () => {}, build: async () => {}, restart: async () => {}, health: async () => {}, pin: async () => {}, prune: async () => {}, schema: async () => 1, database: async () => 1, ...ports };
}

/** The same over a real CLI checkout: fetch, head and checkout are git, as the deploy unit runs them. */
export function gitDeployPorts(checkout: string, ports: Partial<DeployWatchPorts> = {}): DeployWatchPorts {
  const git = gitWatchPorts(checkout, defaultChildRun);
  return deployPorts(git.fetch, git.head, { ...git, ...ports });
}
