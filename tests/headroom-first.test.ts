import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, proposedRuntimes, type AgentRegistry, type FleetSession } from '../src/model/registry.js';

// GY-3498: one account driven to its ceiling took every session on it down together while others
// idled. Eligible accounts whose highest usage window is at or above 80% now trail the role's others.

const HOST = 'machine-a', clock = Date.parse('2030-01-01T12:00:00Z'), iso = (at: number) => new Date(at).toISOString();
const resetsAt = iso(clock + 4 * 3_600_000);

/** Three claude accounts on their own plans, the role ordering a, b, c; `percent` seeds each one's 5h window (null: no reading). */
function registry(percent: Record<string, number | null>): AgentRegistry {
  const fleet = applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: ['a', 'b', 'c'].map(name => ({ name, runtime: 'claude', model: 'opus', plan: `plan-${name}`, credential: { host: HOST, home: `/agents/${name}` } })),
    roles: [{ name: 'worker', accounts: ['a', 'b', 'c'], concurrency: 10 }], reason: 'fixture',
  }, { actor: 'operator', at: iso(clock - 60_000) }).registry;
  for (const account of fleet.accounts) {
    const used = percent[account.name];
    account.quota = { ...account.quota, loggedIn: true, state: 'available', usage: used === null ? [] : [{ window: '5h', percent: used, resetsAt }, { window: '7d', percent: Math.min(used, 10), resetsAt: iso(clock + 5 * 86_400_000) }] };
  }
  return fleet;
}
const launch = (fleet: AgentRegistry, at: number, work: string) => {
  const choice = chooseSession(fleet, { role: 'worker', host: HOST }, at);
  assert.ok(choice.account, `launch ${work} was refused: ${choice.reason}`);
  const session: FleetSession = { id: randomUUID(), role: 'worker', account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: HOST, work, principal: 'worker-a', selectedAt: iso(at), selectedBy: 'master', reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
  fleet.sessions.push(session);
  return session;
};

test('integration:headroom-first — eligible accounts at or above 80% of their highest window are tried after those with room or no reading; ties keep the role order', () => {
  // A at 76% holding three live sessions, B at 20%, C unread: B serves.
  const spread = registry({ a: 76, b: 20, c: null });
  for (const work of ['GY-1', 'GY-2', 'GY-3']) spread.sessions.push({ id: randomUUID(), role: 'worker', account: 'a', runtime: 'claude', model: 'opus', host: HOST, work, principal: 'worker-a', selectedAt: iso(clock - 1000), selectedBy: 'master', reason: 'fixture', skipped: [], endedAt: null, endReason: null });
  assert.equal(chooseSession(spread, { role: 'worker', host: HOST }, clock).account?.name, 'b');

  // A at 85%, B at 20%, C unread, nothing live: the role's first account trails, B serves.
  const hot = chooseSession(registry({ a: 85, b: 20, c: null }), { role: 'worker', host: HOST }, clock);
  assert.equal(hot.account?.name, 'b', hot.reason);
  assert.match(hot.reason, /room left/);
  // C, with no reading, leads A too.
  assert.equal(chooseSession(registry({ a: 85, b: 95, c: null }), { role: 'worker', host: HOST }, clock).account?.name, 'c');

  // A at 85%, B at 90%, C at 80%: all trail, so the role's order stands and A is chosen first.
  assert.equal(chooseSession(registry({ a: 85, b: 90, c: 80 }), { role: 'worker', host: HOST }, clock).account?.name, 'a');

  // A trailing account is never refused: with only hot accounts it still serves.
  const full = registry({ a: 99, b: 99, c: 99 });
  assert.deepEqual([1, 2, 3].map(n => launch(full, clock + n, `GY-${n}`).account), ['a', 'b', 'c']);
});

test('e2e:headroom-first — five launches in a row land on the two accounts with room first, the selection reason naming room left', () => {
  const fleet = registry({ a: 88, b: 30, c: 45 });
  const sessions = [1, 2, 3, 4, 5].map(n => launch(fleet, clock + n, `GY-${100 + n}`));
  assert.deepEqual(sessions.map(session => session.account).filter(name => name === 'a'), [], `the hot account took a launch: ${sessions.map(session => session.account).join(', ')}`);
  assert.deepEqual(new Set(sessions.map(session => session.account)), new Set(['b', 'c']));
  for (const session of sessions) assert.match(session.reason, /room left/, session.reason);
});
