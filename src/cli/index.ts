import { accountsCommands } from './accounts.js';
import type { CliCommand } from './registry.js';
import { installCommands } from './install.js';
import { dbCommands } from './db.js';
import { masterCommands } from './master.js';
import { admissionAuditCommands } from './merge-admission-audit.js';
import { workCommands } from './work.js';
import { briefCommands } from './brief.js';
import { askCommands } from './ask.js';
import { policyCommands } from './policy.js';
import { deliveryCommands } from './delivery.js';
import { scenarioCommands } from './scenarios.js';
import { operatorAgentCommands } from './operator-agent.js';
import { leaseCommands } from './lease.js';
import { workspaceCommands } from './workspace.js';
import { reviewCommands } from './review.js';
import { guideCommands } from './guide.js';
import { versionCommands } from './version.js';
import { upgradeCommands } from './upgrade-commands.js';
import { hostCommands } from './hosts.js';
import { benchCommands } from './bench.js';
import { teamAccessCommands } from './team-access.js';
import { infraCommands } from './infra.js';
import { COMMAND_NAME, PRODUCT_NAME } from '../model/product.js';

/**
 * Every command the launcher answers to, in help order. A feature adds its commands to
 * one module, or adds a module here; nothing else in the launcher changes.
 */
export const commands: readonly CliCommand[] = [
  ...accountsCommands, ...installCommands, ...dbCommands, ...masterCommands, ...workCommands, ...briefCommands, ...askCommands, ...admissionAuditCommands, ...policyCommands,
  ...deliveryCommands, ...scenarioCommands,
  ...operatorAgentCommands, ...leaseCommands, ...workspaceCommands,
  ...reviewCommands, ...guideCommands, ...versionCommands, ...upgradeCommands, ...hostCommands, ...benchCommands, ...teamAccessCommands, ...infraCommands,
];

export function renderHelp() {
  return `${PRODUCT_NAME} 0.1 — distributed work, explicit proof

Usage: ${COMMAND_NAME} COMMAND (the old graphyard command and GRAPHYARD_* settings still work)
Environment: MAINWORKS_URL, MAINWORKS_TOKEN (individual role-scoped credential)
${commands.flatMap(entry => entry.help).join('\n')}

Use MAINWORKS_REQUEST_ID to safely retry an identical command after a network timeout.
Never share an operator or producer credential with an implementation agent.`;
}

export async function main(argv = process.argv.slice(2)) {
  try { process.loadEnvFile(); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const [command, id, ...args] = argv;
  if (!command || command === 'help' || command === '--help') { console.log(renderHelp()); return; }
  const selected = commands.find(entry => entry.name === command || entry.aliases?.includes(command));
  // A subcommand's help flag is answered by the launcher before any command runs, so
  // `mainworks login --help` prints login's help instead of minting a sign-in link (GY-3172).
  if (selected && [id, ...args].some(word => word === '--help' || word === '-h')) { console.log(selected.help.join('\n')); return; }
  const { createContext, resolveWork } = await import('./context.js');
  const context = await createContext(command, id, args, selected?.readsConnection?.(id) ?? true);
  if (selected && selected.scope !== 'work') return selected.run(context, undefined);
  if (selected?.unscoped && !id) return selected.unscoped(context);
  // Work-scoped commands name an item by ID or display key; the lookup precedes the
  // command check so an unknown item is reported before an unknown command.
  const work = await resolveWork(context.api, id);
  if (!selected) throw new Error(`Unknown command: ${command}`);
  return selected.run(context, work);
}
