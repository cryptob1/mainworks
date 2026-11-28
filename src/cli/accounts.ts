import { fleetView, roleRuntimeRefusal, roleLimit, type AgentRegistry } from '../model/registry.js';
import { roleUnsupported } from '../model/worker-preference.js';
import { defineCommands } from './registry.js';

export const accountsCommands = defineCommands([{
  name: 'accounts',
  help: ['  accounts health              Each account’s runtime, role, launch readiness and quota reset'],
  run: async ({ id, api }) => {
    if (id !== 'health') throw new Error('Use mainworks accounts health');
    const registry: AgentRegistry = await api('agent-registry/document');
    const view = fleetView(registry, Date.now());
    const rows = view.accounts.map(account => {
      const own = registry.accounts.find(entry => entry.name === account.name)!;
      const reasons = account.roles.map(({ role }) => {
        const configured = registry.roles.find(entry => entry.name === role)!;
        const running = view.roles.find(entry => entry.role === role)!.live;
        return account.held.find(held => held.role === role)?.reason ?? roleRuntimeRefusal(registry, own, role)
          ?? roleUnsupported(registry, configured, account.name)
          ?? (running >= roleLimit(configured) ? `${role} is at its session limit` : null);
      });
      const reason = account.ineligible ?? (!reasons.length ? 'No role assigned' : reasons.every(Boolean) ? reasons[0] : null);
      return [account.name, account.runtime, account.roles.map(entry => entry.role).join(', ') || '—', reason ? 'no' : 'yes', reason ?? '—', account.resetsAt ?? 'unknown'];
    });
    console.log([['Account', 'Runtime', 'Role', 'Launch', 'Reason', 'Reset'], ...rows].map(row => row.map(cell => String(cell).replace(/\s+/g, ' ')).join('\t')).join('\n'));
  },
}]);
