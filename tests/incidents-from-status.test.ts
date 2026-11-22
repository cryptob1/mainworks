import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incidentsFromStatus, statusLine, type StatusSnapshot } from '../src/model/incidents.js';
import type { Work } from '../src/model.js';

// GY-3601: this week's faults — a release check wedged 28 hours, accounts wrongly held, both test
// machines offline, finished work not pushed — were invisible on Home. Each timer fires on its own.

const minute = 60_000, hour = 60 * minute, now = Date.parse('2026-11-22T15:00:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const item = (n: number, extra: Partial<Work> = {}) => ({ id: `id-${n}`, key: `GY-${n}`, title: `Item ${n}`, stage: 'build', stageEnteredAt: ago(10 * minute), lease: null, dependencies: [], ...extra }) as unknown as Work;
const building = (n: number) => item(n, { lease: { owner: 'graphyard-claude-1', epoch: 1, expiresAt: ago(-hour) } as Work['lease'] });
const mergedAgo = (n: number, ms: number) => item(n, { stage: 'done', delivery: { mergedAt: ago(ms) } as Work['delivery'] });
const account = (name: string, eligible: boolean, resetsAt: string | null = null) => ({ name, eligible, resetsAt, roles: [{ role: 'worker' }] });
const kinds = (status: StatusSnapshot, work: Work[] = []) => incidentsFromStatus(status, work, now).map(incident => incident.kind);

test('unit:incidents-from-status — the release check fires after 30 minutes of trying, not before', () => {
  assert.deepEqual(kinds({ releaseCheck: { since: ago(29 * minute) } }), []);
  const [card] = incidentsFromStatus({ releaseCheck: { since: ago(28 * hour) }, live: { commit: 'a', waiting: ['GY-1', 'GY-2', 'GY-3'] } }, [], now);
  assert.equal(card.kind, 'release-check');
  assert.equal(card.broke, 'The release check has not passed in 28 h.');
  assert.equal(card.impact, '3 finished changes wait to go live.');
  assert.equal(card.action?.label, 'Ask the Lead');
});

test('unit:incidents-from-status — a finished, approved head fires when not pushed in 30 minutes', () => {
  assert.deepEqual(kinds({}, [item(1, { stage: 'merge', stageEnteredAt: ago(20 * minute) })]), []);
  const [card] = incidentsFromStatus({}, [item(1, { stage: 'merge', stageEnteredAt: ago(45 * minute) })], now);
  assert.equal(card.kind, 'not-pushed');
  assert.deepEqual(card.action, { label: 'Open the change', open: 'item', item: 'id-1' });
});

test('unit:incidents-from-status — held accounts fire above a quarter; held until a known reset says nothing is needed', () => {
  assert.deepEqual(kinds({ fleet: { accounts: [account('a', false), account('b', true), account('c', true), account('d', true)] } }), []);
  const [broken] = incidentsFromStatus({ fleet: { accounts: [account('a', false), account('b', false), account('c', true), account('d', true)] } }, [], now);
  assert.equal(broken.kind, 'accounts');
  assert.equal(broken.broke, '2 of 4 Builder accounts are held, so the team runs slower.');
  assert.equal(broken.action?.label, 'Open accounts');
  const [healing] = incidentsFromStatus({ fleet: { accounts: [account('a', false, ago(-hour)), account('b', false, ago(-hour)), account('c', true)] } }, [], now);
  assert.equal(healing.action, null);
  assert.match(healing.doing, /Nothing needed/);
});

test('unit:incidents-from-status — a test machine fires when away over 5 minutes, not when answering or briefly away', () => {
  assert.deepEqual(kinds({ hosts: [{ host: 'a', away: false, at: ago(0) }, { host: 'b', away: true, since: ago(4 * minute) }] }), []);
  const cards = incidentsFromStatus({ hosts: [{ host: 'a', away: true, since: ago(6 * minute) }, { host: 'b', away: true, since: ago(hour) }] }, [], now);
  assert.deepEqual(cards.map(card => card.kind), ['machine-away', 'machine-away']);
  assert.equal(cards[1].broke, 'Test machine b has not answered for 1 h.');
});

test('unit:incidents-from-status — no merge in 2 hours fires only while tasks are in flight, and stops the line', () => {
  assert.deepEqual(kinds({}, [mergedAgo(1, 3 * hour)]), []);
  assert.deepEqual(kinds({}, [mergedAgo(1, 90 * minute), building(2)]), []);
  const work = [mergedAgo(1, 3 * hour), building(2)];
  const incidents = incidentsFromStatus({}, work, now);
  assert.deepEqual(incidents.map(incident => incident.kind), ['no-merge']);
  assert.equal(statusLine({}, work, incidents, now).state, 'Stopped');
});

test('unit:incidents-from-status — the status line: Moving with no incident, Builders of allowed, machines ready of configured, last live', () => {
  const status: StatusSnapshot = { fleet: { roles: [{ role: 'worker', live: 3, limit: 9 }] }, hosts: [{ host: 'a', away: false }, { host: 'b', away: false }, { host: 'c', away: true, since: ago(minute) }], app: { deployedAt: ago(2 * hour) } };
  const line = statusLine(status, [mergedAgo(1, 10 * minute)], incidentsFromStatus(status, [], now), now);
  assert.equal(line.state, 'Moving');
  assert.deepEqual(line.builders, { working: 3, allowed: 9 });
  assert.deepEqual(line.machines, { ready: 2, configured: 3 });
  assert.equal(line.lastLive, '2 h');
  assert.equal(statusLine({}, [], [{ kind: 'accounts' } as never], now).state, 'Slowed');
});
