import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model';
import { workFixture } from './helpers/work-fixture.js';
import { decisionFrom, goalOrder, leadFeed, pausesFrom, steerers, type LedgerRow, type RegistryRow } from '../web/lead-feed';

// GY-3602: the Lead's conversation is one time-ordered feed of what people typed and the cards the
// control plane's own records reply with — approvals, audited decisions, incidents and filings.

const minute = 60_000;
const start = Date.parse('2026-11-22T09:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const item = (id: string, key: string, priority: number, createdAt = start): Work => workFixture({ id, key, title: `Title of ${key}`, priority, createdAt: iso(createdAt), updatedAt: iso(createdAt), stageEnteredAt: iso(createdAt), criteria: [], sessions: [], gates: [], epoch: 1, revision: 4 });
const row = (kind: string, work: string | null, at: number, details: Record<string, unknown> = {}): LedgerRow => ({ seq: String(at), work_id: work, actor: 'graphyard-master', kind, created_at: iso(at), details });

test('unit:lead-feed — one time-ordered feed, newest last, across messages, filings, decisions, approvals and incidents', () => {
  const work = [item('a', 'GY-1', 1), item('b', 'GY-2', 2)];
  const feed = leadFeed({
    typed: [{ who: 'operator', at: iso(start - 2 * minute), text: 'Why is the release stuck?' }, { who: 'steerer', at: iso(start + 2 * minute), text: 'Looks fine from here.' }],
    requests: [{ request: { id: 'r1', kind: 'money-or-accounts', reason: 'r', needed: 'n', requestedBy: 'w', epoch: 1, at: iso(start) }, rule: 'human-request', work: 'GY-1', id: 'a', title: 't', waitedMs: 0, decision: 'spend', refusal: '', answer: {} as never } as never],
    ledger: [row('create', 'a', start - minute), row('priority', 'b', start + minute, { priority: 0, oldPriority: 2, newPriority: 0, reason: 'release first' })],
    registry: [],
    incidents: [{ id: 'i', workId: 'b', key: 'GY-2', status: 'missing', reason: 'not served', since: iso(start - 3 * minute) }],
    work,
  });
  assert.deepEqual(feed.map(entry => [entry.kind, entry.at]), [
    ['incident', start - 3 * minute],
    ['message', start - 2 * minute],
    ['task', start - minute],
    ['approval', start],
    ['decision', start + minute],
    ['message', start + 2 * minute],
  ]);
  assert.equal((feed[0] as { incident: { key: string } }).incident.key, 'GY-2');
  assert.equal((feed[1] as { who: string }).who, 'operator');
  assert.equal((feed[2] as { item: { key: string } }).item.key, 'GY-1');
});

test('unit:lead-feed — Undo only on a priority change, a hold or a pause, each calling its reversing command', () => {
  const held = item('c', 'GY-3', 1), other = item('e', 'GY-5', 1);
  const priority = decisionFrom(row('priority', 'c', start, { priority: 1, oldPriority: 2, reason: 'the owner asked' }), [held]);
  const hold = decisionFrom(row('hold', 'c', start, { reason: 'waiting on the owner' }), [held]);
  const rework = decisionFrom(row('rework', 'e', start, { reason: 'the review found a gap' }), [other]);
  const unblock = decisionFrom(row('unblock', 'e', start, { reason: 'cleared the account' }), [other]);
  const message = decisionFrom(row('message', 'e', start, { text: 'stay on the release fix' }), [other]);
  assert.deepEqual(priority!.undo, { target: 'work', workId: 'c', command: 'priority', data: { priority: 2, reason: 'Owner undid the priority change for GY-3 from the Lead page' } });
  assert.deepEqual(hold!.undo, { target: 'work', workId: 'c', command: 'ready', data: { expectedRevision: 4, reason: 'Owner undid the hold on GY-3 from the Lead page' } });
  assert.equal(rework!.undo, null);
  assert.equal(unblock!.undo, null);
  assert.equal(message!.undo, null);
  // The owner's own dashboard priority change is their steering, not the Lead's reply.
  assert.equal(decisionFrom(row('priority', 'c', start, { priority: 1, oldPriority: 2, reason: 'Priority changed from P2 to P1 from the dashboard' }), [held]), null);
  // A hold with no item to release names no undo: the command could not name its target.
  assert.equal(decisionFrom(row('hold', null, start, { reason: 'waiting' }), [])!.undo, null);
});

test('unit:lead-feed — a registry pause reads its previous concurrency and its undo restores it', () => {
  const rows: RegistryRow[] = [
    { seq: '3', at: iso(start + 2 * minute), actor: 'graphyard-master', kind: 'role.set', change: { role: { name: 'worker', accounts: ['claude-a'], concurrency: 0 }, reason: 'spend approval first' } },
    { seq: '2', at: iso(start + minute), actor: 'graphyard-master', kind: 'role.set', change: { role: { name: 'worker', concurrency: 2 }, reason: 'the fleet at the start' } },
    { seq: '1', at: iso(start), actor: 'graphyard-master', kind: 'apply', change: { roles: [{ name: 'worker', concurrency: 4 }], reason: 'initial' } },
  ];
  const pauses = pausesFrom(rows);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0]!.what, 'The worker role paused');
  assert.deepEqual(pauses[0]!.undo, { target: 'registry', body: { role: { name: 'worker', accounts: ['claude-a'], concurrency: 2 }, reason: 'Owner unpaused the worker role from the Lead page' } });
  // A pause with no earlier concurrency in the read cannot name its reverse, so it offers none.
  assert.equal(pausesFrom([rows[0]!])[0]!.undo, null);
  assert.equal(pausesFrom([{ seq: '4', at: iso(start + 3 * minute), actor: 'a', kind: 'role.set', change: { role: { name: 'reviewer', concurrency: 3 }, reason: 'r' } }]).length, 0);
});

test('unit:lead-feed — the side rail: goal order by priority, and who can steer', () => {
  const work = [item('a', 'GY-1', 2), item('b', 'GY-2', 1), item('c', 'GY-3', 1, start + minute), item('d', 'GY-4', 0), item('e', 'GY-5', 0, start + 5 * minute)];
  assert.deepEqual(goalOrder(work).map(goal => goal.key), ['GY-4', 'GY-5', 'GY-2']);
  assert.deepEqual(steerers([{ login: 'ana@example.com', role: 'maintainer' }, { login: 'bo@example.com', role: 'viewer' }], true), ['You', 'ana']);
  assert.deepEqual(steerers([], false), ['The operator']);
});

test('unit:lead-feed — the status line never says connecting when the terminal is refused', async () => {
  const { leadStatus } = await import('../web/pages/master');
  assert.deepEqual(leadStatus({ session: null, mode: 'refused', reason: 'Sign in to see the terminal.' }, start), { words: 'Sign in to see the terminal.', age: null, state: 'refused' });
  assert.equal(leadStatus({ session: null, mode: 'connecting', reason: '' }, start).state, 'connecting');
  const working = leadStatus({ session: { state: 'working', since: iso(start - 5 * minute) }, mode: 'control', reason: '' }, start);
  assert.equal(working.words, 'Lead is working'); assert.equal(working.state, 'working'); assert.match(working.age ?? '', /5m/);
});
