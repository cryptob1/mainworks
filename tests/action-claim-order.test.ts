import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { actionId } from '../src/model-boundary/actions.js';
import { claimable, openActions, type ActionRow } from '../src/model/actions.js';
import type { NextActionKind } from '../src/model/next-action.js';

/**
 * GY-1132: a P0 item's resync once waited 25 minutes behind 34 hours-old dispatch rows. `openActions`
 * orders rows by the item's priority, then rows that unblock a merge, then age; a worker's pull
 * takes dispatch offers in that order.
 */

let sequence = 0;
/** An item holding one open row of `kind`, requested at `requestedAt`. */
function item(options: { priority: number; stage: Work['stage']; kind: NextActionKind; requestedAt: Date }): Work {
  const id = randomUUID(), key = `GY-${9000 + ++sequence}`;
  const row: ActionRow = {
    id: actionId(options.kind, id, `${options.kind}:0`), kind: options.kind, work: id, key, inputs: {} as ActionRow['inputs'],
    gate: null, refusal: null, reason: `${key} needs ${options.kind}`, binding: `${options.kind}:0`,
    requestedBy: 'graphyard', requestedAt: options.requestedAt.toISOString(), state: 'pending', claim: null, attempts: 0, history: [],
  };
  return { id, key, title: key, priority: options.priority, stage: options.stage, actionQueue: { actions: [row], history: [] } } as unknown as Work;
}
const rowOf = (work: Work) => work.actionQueue!.actions[0];
/** The items `openActions` would serve, in order of their first row. */
const servedItems = (all: Work[], now: Date, kinds?: readonly NextActionKind[]) => [...new Set(openActions(all, now, kinds).map(entry => entry.work.id))];

test('unit:claim-order-priority-before-age — a later P0 resync at the merge stage is served ahead of 40 older P2 dispatch rows', () => {
  const now = new Date();
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const dispatches = Array.from({ length: 40 }, (_unused, index) => item({ priority: 2, stage: 'ready', kind: 'dispatch', requestedAt: new Date(hoursAgo(30).getTime() + index * 60_000) }));
  const resync = item({ priority: 0, stage: 'merge', kind: 'resync', requestedAt: hoursAgo(1) });
  assert.equal(servedItems([...dispatches, resync], now, ['dispatch', 'resync'])[0], resync.id, 'the priority-0 resync row is served first, though requested last');
  // The kind order, within one priority: a row that unblocks a merge goes ahead of an older dispatch;
  // a resync on an item not yet at the merge stage unblocks no merge and keeps its age order.
  const olderDispatch = item({ priority: 1, stage: 'ready', kind: 'dispatch', requestedAt: hoursAgo(10) });
  const mergeRow = item({ priority: 1, stage: 'merge', kind: 'merge', requestedAt: hoursAgo(2) });
  const earlyResync = item({ priority: 1, stage: 'test', kind: 'resync', requestedAt: hoursAgo(3) });
  const higherDispatch = item({ priority: 0, stage: 'ready', kind: 'dispatch', requestedAt: hoursAgo(1) });
  const mixed = [olderDispatch, mergeRow, earlyResync, higherDispatch, ...dispatches.slice(0, 3)];
  const expected = [higherDispatch, mergeRow, olderDispatch, earlyResync, ...dispatches.slice(0, 3)].map(work => work.id);
  assert.deepEqual(servedItems(mixed, now), expected, 'priority, then merge-unblocking rows, then the oldest request');

  // A row whose requestedAt is malformed counts as oldest rather than failing.
  const malformed = item({ priority: 2, stage: 'ready', kind: 'dispatch', requestedAt: now });
  rowOf(malformed).requestedAt = 'not a timestamp';
  const withMalformed = [...dispatches.slice(0, 3), malformed];
  assert.deepEqual(servedItems(withMalformed, now)[0], malformed.id, 'openActions places a malformed requestedAt first among its peers');

  // A row backing off is not offered before its retryAt, and heads the order again at it.
  const backing = item({ priority: 0, stage: 'ready', kind: 'dispatch', requestedAt: hoursAgo(40) });
  const retryAt = new Date(now.getTime() + 60_000);
  rowOf(backing).retryAt = retryAt.toISOString();
  assert.equal(claimable(rowOf(backing), now), false, 'it is not claimable before its retryAt');
  assert.ok(!servedItems([backing, ...dispatches.slice(0, 3)], now).includes(backing.id), 'openActions does not offer it before its retryAt');
  assert.equal(servedItems([backing, ...dispatches.slice(0, 3)], retryAt)[0], backing.id, 'it heads the order again at its retryAt');
});
