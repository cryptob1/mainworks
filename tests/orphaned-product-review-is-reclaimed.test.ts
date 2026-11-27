import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import type { SessionHandle, SessionHandleInput } from '../src/model/sessions.js';
import { loadMasterConfig } from '../src/master/config.js';
import { sessionAgentName, type MasterConfig } from '../src/master/profiles.js';
import { emptyDispatchCursor, type DispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { closureHandle, type SessionClosure } from '../src/dispatch/session-sweep.js';
import { type DispatchEffects } from '../src/dispatch/effects.js';
import { fleet, requested } from './helpers/review-fleet.js';
import { registryFixture } from './helpers/registry-fixture.js';

// GY-4019: GY-4000 sat in review for over 40 minutes with no reviewer. Its headless product review
// run vanished across the 11:43Z loop restart; the item's session handle stayed `running` (a handle
// its request names was held, never lost) and the agent-registry reviewer session it was launched
// under kept the item's product slot ("role reviewer already reserved for GY-4000"), so every
// relaunch waited. A headless product review the runtime no longer lists is now lost after the usual
// two missed reports, its registry session ends, and the request launches one fresh reviewer.

const productId = 'bec06ae6e99bc2fd3c252dfdad556ec9';

/** An item in review whose only open request is a product review, with that review's headless session recorded running. */
function inReview(host: string, agentName: string | null): Work {
  const base = requested(1);
  const review = base.autoDispatch!.review!;
  const product = { ...review, id: productId, kind: 'product' as const, reason: 'product review is required before this user-facing feature merges' };
  const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  const handle = { id: productId, kind: 'review', principal: 'graphyard-master', epoch: null, runtime: 'claude', host, workspace: 'wC', tab: null, pane: null,
    agentName, role: 'review:product', head: product.sha, attach: null, transcript: null, subject: `${base.key}: product review ${product.sha.slice(0, 12)}`,
    startedAt, updatedAt: startedAt, endedAt: null, state: 'running', outcome: null, launch: 'launch-before-restart', ...(agentName ? { observed: 'working', observedAt: startedAt } : {}), missedReports: 0 } as SessionHandle;
  return { ...base, autoDispatch: { ...base.autoDispatch!, review: null, product }, sessions: [handle] } as Work;
}

/** The control plane's session writes, applied to the in-memory item. */
function applyHandle(item: Work, input: SessionHandleInput) {
  const sessions = item.sessions ?? [], at = new Date().toISOString();
  const existing = sessions.find(handle => handle.id === input.id);
  // A running handle another launch holds refuses this launch's writes, unless it supersedes it (engine.ts).
  const launch = (input as { launch?: string }).launch, holder = (existing as { launch?: string } | undefined)?.launch;
  if (existing?.state === 'running' && launch && holder && launch !== holder && !(input as { supersede?: boolean }).supersede) throw new Error(`session ${input.id} is held by launch ${holder}`);
  const fresh = !existing || (existing.state !== 'running' && input.state === 'running');
  const next = { ...(fresh ? { startedAt: at, missedReports: 0, observed: undefined, observedAt: undefined, outcome: null, endedAt: null } : existing), ...input, updatedAt: at,
    ...(input.state === 'finished' ? { endedAt: at } : {}) } as SessionHandle;
  item.sessions = existing ? sessions.map(handle => handle === existing ? next : handle) : [...sessions, next];
}

async function setup(agentName: (config: MasterConfig) => string | null) {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude', concurrency: 2 }, 'claude-reviewer');
  const config = await loadMasterConfig(host.root);
  const registry = registryFixture(config.hostId!, ['claude'], ['reviewer'], 4);
  // The registry session the vanished run was launched under, holding the item's product slot.
  const held = await registry.client.select({ role: 'reviewer', host: config.hostId!, work: 'GY-501', group: 'product', principal: null, observations: [] });
  assert.ok(held.selected);
  const item = inReview(config.hostId!, agentName(config));
  /** The headless runs this loop lists, as its session inventory does. */
  const runs: { name: string; agent: string; agent_status: string }[] = [];
  const launches: string[] = [];
  let unreachable = false;
  const effects = (): DispatchEffects => ({ ...host.effects(() => [item], () => config),
    snapshot: async () => { if (unreachable) throw new Error('fetch failed: connect ECONNREFUSED'); return { work: [item], now: new Date().toISOString() }; },
    agents: () => [...runs],
    // No ledger record survived the outage: the item's handle and the registry are all that remain.
    reconcileReviews: async () => ({ reviews: [], released: [], notLive: [] }),
    recordSession: async (work, handle) => applyHandle(work, handle),
    endSession: async (closure: SessionClosure) => applyHandle(item, closureHandle(closure)),
    registry: () => registry.client.document(), endRegistrySession: (session, reason) => registry.client.end(session.id, reason),
    // The real launcher asks the registry for the slot and refuses at capacity; a chosen one starts a headless run listed under its name.
    launchProductReview: async (work, request, profile) => {
      const selection = await registry.client.select({ role: 'reviewer', host: config.hostId!, work: work.key, group: 'product', principal: null, observations: [] });
      if (!selection.selected) throw Object.assign(new Error(`No healthy agent account for reviewer profile ${profile.name}: ${selection.reason}`), { roleAtCapacity: selection.reason });
      const name = sessionAgentName(profile, { id: request.id, requestId: request.id, attempt: launches.length + 2 });
      launches.push(name); runs.push({ name, agent: 'claude', agent_status: 'working' });
      return { agentName: name };
    } });
  const tick = (cursor: DispatchCursor) => runDispatchTick(config, cursor, effects(), Date.now);
  const live = () => registry.sessions().filter(session => !session.endedAt && session.role === 'reviewer' && session.work === 'GY-501');
  const running = () => (item.sessions ?? []).filter(handle => handle.state === 'running');
  return { host, config, item, runs, launches, tick, live, running, held: held.session!, setUnreachable: (value: boolean) => { unreachable = value; } };
}

test('integration:orphaned-product-review-is-reclaimed — a headless product review whose run is gone is lost on its second missed report, its registry session ends, and one fresh reviewer launches for the head', async () => {
  // The GY-4000 handle: registered before its runtime started, never given a name to match.
  const { host, config, item, launches, tick, live, running, held } = await setup(() => null);
  try {
    const cursor = emptyDispatchCursor(config);
    const first = await tick(cursor);
    assert.equal(running().length, 1, 'one missed report loses nothing');
    assert.equal(running()[0].missedReports, 1);
    assert.deepEqual(first.launched, [], 'the vanished run still holds the item\'s product slot on the first miss');
    assert.match(first.waiting.find(entry => entry.requestId === productId)?.reason ?? '', /already reserved for GY-501/);

    const second = await tick(cursor);
    // The relaunch reopens the handle under its request's id, so the closure is read off the tick.
    const lost = second.closed.find(closure => closure.id === productId);
    assert.ok(lost, 'the vanished product review session is closed');
    assert.equal(lost!.report?.observed, 'lost');
    assert.match(lost!.outcome, /^vanished: .*product review.*absent from 2 consecutive session reports/);
    assert.ok(live().every(session => session.id !== held.id), 'its agent-registry reviewer session is ended');
    assert.deepEqual(second.launched.map(entry => [entry.work, entry.requestId, entry.reason]), [['GY-501', productId, 'product review']], 'the pending request launches one new product reviewer');
    assert.equal(launches.length, 1);
    assert.equal(running().length, 1, 'exactly one live product reviewer');
    assert.equal(running()[0].agentName, launches[0]);
    assert.equal(live().length, 1);

    // The fresh run is listed: nothing more is lost, ended or launched.
    for (let n = 0; n < 3; n++) assert.deepEqual((await tick(cursor)).launched, []);
    assert.equal(launches.length, 1);
    assert.deepEqual(running().map(handle => [handle.agentName, handle.observed]), [[launches[0], 'working']]);
  } finally { await host.cleanup(); }
});

test('integration:orphaned-product-review-is-reclaimed — a live product review the restarted loop adopted is neither duplicated nor ended, named on its handle or not', async () => {
  for (const named of [true, false]) {
    const name = (config: MasterConfig) => sessionAgentName(config.reviewers.find(profile => profile.name === 'claude-reviewer')!, { id: productId, requestId: productId });
    const { host, config, runs, launches, tick, live, running, held } = await setup(config => named ? name(config) : null);
    try {
      // The adopted run is listed again under its session name.
      runs.push({ name: name(config), agent: 'claude', agent_status: 'working' });
      const cursor = emptyDispatchCursor(config);
      for (let n = 0; n < 4; n++) assert.deepEqual((await tick(cursor)).launched, [], `nothing launches beside the adopted review (${named ? 'named' : 'nameless'} handle)`);
      assert.equal(launches.length, 0);
      assert.equal(running().length, 1, 'the adopted review stays running');
      assert.equal(running()[0].missedReports ?? 0, 0);
      assert.deepEqual(live().map(session => session.id), [held.id], 'its registry session stays live');
    } finally { await host.cleanup(); }
  }
});

test('e2e:orphaned-product-review-is-reclaimed — across a loop restart with the server briefly unreachable, an item in review ends up with exactly one live product reviewer that reaches a verdict', async () => {
  const name = (config: MasterConfig) => sessionAgentName(config.reviewers.find(profile => profile.name === 'claude-reviewer')!, { id: productId, requestId: productId });
  const { host, config, item, runs, launches, tick, live, running, setUnreachable } = await setup(name);
  try {
    // The old loop saw its product review working.
    runs.push({ name: name(config), agent: 'claude', agent_status: 'working' });
    const before = emptyDispatchCursor(config);
    assert.deepEqual((await tick(before)).launched, []);
    assert.equal(running()[0].observed, 'working');

    // The loop restarts: its headless run dies with it, the new loop starts on a fresh cursor, and the
    // control plane is unreachable for its first ticks.
    runs.splice(0, runs.length);
    const after = emptyDispatchCursor(config);
    setUnreachable(true);
    for (let n = 0; n < 2; n++) await assert.rejects(tick(after), /ECONNREFUSED/);
    assert.equal(running().length, 1, 'an unreachable server judges nothing');
    setUnreachable(false);

    // Back up: the vanished run is lost on its second miss and one fresh reviewer launches.
    const closed: string[] = [];
    for (let n = 0; n < 3 && !launches.length; n++) closed.push(...(await tick(after)).closed.filter(closure => closure.report?.closed === 'lost').map(closure => closure.id));
    assert.equal(launches.length, 1, 'exactly one fresh product reviewer');
    assert.deepEqual(running().map(handle => handle.agentName), [launches[0]]);
    assert.equal(live().length, 1);
    assert.deepEqual(closed, [productId], 'the vanished run is recorded lost, not running');

    // The fresh reviewer posts its verdict: the request is satisfied and its run ends.
    item.autoDispatch = { ...item.autoDispatch!, product: null, history: [...item.autoDispatch!.history ?? [], { ...item.autoDispatch!.product!, state: 'satisfied', resolvedAt: new Date().toISOString(), resolution: 'approved by product review' }] };
    runs.splice(0, runs.length);
    await tick(after);
    assert.deepEqual(running(), [], 'no reviewer is left recorded running against a vanished run');
    assert.equal(launches.length, 1);
    assert.match(item.sessions!.find(handle => handle.agentName === launches[0])?.outcome ?? '', /request was satisfied/);
  } finally { await host.cleanup(); }
});
