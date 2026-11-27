import { bashRuleMatches, type HarnessPlan, type HarnessRule } from '../../src/harness.js';

/** How a Claude harness plan judges one Bash command line: any denied part denies it; it is allowed only when every part is. */
export function harnessDecision(plan: Pick<HarnessPlan, 'allow' | 'deny'>, command: string): { decision: 'allow' | 'deny' | 'ask'; rule: HarnessRule | null } {
  const parts = command.split(/\s*(?:&&|\|\||;|\|)\s*/).map(part => part.trim()).filter(Boolean);
  for (const part of parts) {
    const denied = plan.deny.find(entry => bashRuleMatches(entry.rule, part));
    if (denied) return { decision: 'deny', rule: denied };
  }
  const allowed = parts.map(part => plan.allow.find(entry => bashRuleMatches(entry.rule, part)));
  return parts.length && allowed.every(Boolean) ? { decision: 'allow', rule: allowed[0]! } : { decision: 'ask', rule: null };
}
