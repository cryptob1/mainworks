import { roleRuntimeRefusal, type FleetView } from '../model/registry.js';
import { roleUnsupported } from '../model/worker-preference.js';
import { formatDuration } from '../model/duration.js';
import { defineCommands } from './registry.js';

const resetTime = (iso: string, now: number) => `${new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (in ${formatDuration((Date.parse(iso) - now) / 60_000)})`;

function shortReason(reason: string, name: string): string {
  if (reason.includes('is disabled')) return 'disabled; enable account';
  if (reason.includes('quota is exhausted')) return 'quota exhausted; wait for reset';
  if (/not logged in|no credential|no api key/i.test(reason)) return 'Sign-in needed; connect account';
  if (/smoke test|is broken|is not ready/.test(reason)) return 'Check failed; run account check';
  if (/session limit/.test(reason)) return 'Session limit; wait for a session to finish';
  if (/cannot run|tools flag|not a registered/.test(reason)) return 'Configuration mismatch; update account or role';
  if (/held|unjudged/.test(reason)) return 'Launch held; run account check';
  const plain = reason.startsWith(`${name} `) ? reason.slice(name.length + 1) : reason;
  return plain.length > 70 ? 'Unavailable; run account check' : plain;
}

export const accountsCommands = defineCommands([{
  name: 'accounts',
  help: ['  accounts health              Each account’s runtime, role, launch readiness and quota reset'],
  run: async ({ id, api }) => {
    if (id !== 'health') throw new Error('Use mainworks accounts health');
    const view: FleetView = await api('agent-registry');
    const now = Date.now();
    const rows = view.accounts.map(account => {
      const reasons = account.roles.map(({ role }) => {
        const configured = view.roles.find(entry => entry.role === role)!;
        return account.held.find(held => held.role === role)?.reason ?? roleRuntimeRefusal(view, account, role)
          ?? roleUnsupported(view, { name: role, policy: configured.policy }, account.name)
          ?? (configured.live >= (configured.limit ?? configured.concurrency) ? `${role} is at its session limit` : null);
      });
      const reason = account.ineligible ?? (!reasons.length ? 'No role; assign a role' : reasons.every(Boolean) ? reasons[0] : null);
      const reset = account.resetsAt && Date.parse(account.resetsAt) > now ? resetTime(account.resetsAt, now)
        : account.quota === 'exhausted' ? 'unknown' : '—';
      return [account.name, account.runtime, account.roles.map(entry => entry.role).join(', ') || '—', reason ? 'no' : 'yes', reason ? shortReason(reason, account.name) : '—', reset];
    });
    const table = [['Account', 'Runtime', 'Role', 'Launch', 'Reason', 'Reset'], ...rows].map(row => row.map(cell => String(cell).replace(/\s+/g, ' ')));
    const widths = table[0]!.map((_, column) => Math.max(...table.map(row => row[column]!.length)));
    console.log(table.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join('  ')).join('\n'));
  },
}]);
