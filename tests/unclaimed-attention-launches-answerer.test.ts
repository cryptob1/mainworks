import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { NoHealthyAccountError } from '../src/master/environments.js';
import { openHumanOnly } from '../src/model/human-request.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

/**
 * GY-4029: GY-4010 waited at the ready gate with attention action 7b7ff8d3 pending and unclaimed
 * while role master was live 0 of 1, so nothing answered it. An attention action unclaimed past
 * 30 minutes now launches the master bound to it; with no account able to serve the master, the
 * item is listed under humanOnly with the action's detail.
 */

const at = '2026-11-27T12:20:00Z';
const detail = 'AC-2 needs the hash of the coordinator public key, and the sandbox masks ~/.ssh';

function refusedItem(): Work {
  const reason = `GY-4010 is refused at the ready gate and no executor step answers it: ${detail}`;
  return workFixture({
    id: 'work-4010', key: 'GY-4010', stage: 'ready', epoch: 2, createdAt: at, updatedAt: at, stageEnteredAt: at,
    gates: [{ name: 'ready', passed: false, reasons: [detail] }],
    actionQueue: { history: [], actions: [{
      id: '7b7ff8d3aa', kind: 'attention', work: 'work-4010', key: 'GY-4010', gate: 'ready', refusal: detail, reason,
      inputs: { kind: 'attention', trigger: 'ready', detail }, binding: `ready:2:${detail}`,
      requestedBy: 'graphyard', requestedAt: at, state: 'pending', claim: null, attempts: 0,
      history: [{ at, event: 'requested', requester: 'graphyard', executor: null, result: null, reason }],
    }] },
  });
}

async function fixture(launch: () => Promise<{ agentName: string; pane: string; runtime: string; account: string; session: string }>) {
  const directory = await temporaryDirectory('unclaimed-attention');
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', repository: 'owner/project', credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master', workers: [],
    run: { masterHeartbeatMinutes: 240 },
  });
  const launches: string[] = [], reports: { key: string; event: unknown }[] = [];
  let work = [refusedItem()];
  let now = Date.parse(at);
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    // The loop's master pane is still in Herdr, but the registry holds no live master session.
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => {},
    persist: async () => {},
    reportCapacity: async (item, event) => {
      reports.push({ key: item.key, event });
      const { event: _event, ...spent } = event;
      work = work.map(entry => entry.id === item.id ? { ...entry, capacity: { exhaustions: [], spent: [{ ...spent, at: new Date(now).toISOString(), retryAt: null }] } } as Work : entry);
    },
    masterSession: {
      wake: async () => {},
      live: async () => [],
      launch: async handover => { launches.push(handover); return launch(); },
    },
  };
  const state = emptyDaemonState(config);
  state.master = { ...state.master, agentName: 'master', pane: 'pM', startedAt: at };
  return { launches, reports, state, work: () => work, advance: (minutes: number) => { now += minutes * 60_000; }, now: () => now,
    cycle: () => runCycle(config, state, effects, () => now) };
}

test('integration:unclaimed-attention-launches-answerer — an attention action unclaimed past 30 minutes launches the master bound to it', async () => {
  const f = await fixture(async () => ({ agentName: 'master-2', pane: 'pN', runtime: 'codex', account: 'codex-a', session: 'registered-master' }));
  f.advance(20);
  await f.cycle();
  assert.equal(f.launches.length, 0, 'no launch while the action is younger than 30 minutes');
  f.advance(11);
  await f.cycle();
  assert.equal(f.launches.length, 1, 'one master session launches within one cycle of the 30-minute mark');
  assert.match(f.launches[0], /GY-4010/);
  assert.ok(f.launches[0].includes('7b7ff8d3'), 'the launch is bound to the action');
  assert.ok(f.launches[0].includes(detail), 'the launch carries the action detail');
  assert.equal(f.state.master.session, 'registered-master');
});

test('integration:unclaimed-attention-launches-answerer — with no account able to serve the master, status lists the item under humanOnly', async () => {
  const f = await fixture(async () => { throw new NoHealthyAccountError('no master account is available', []); });
  f.advance(31);
  await f.cycle();
  assert.equal(f.launches.length, 1, 'the launch is tried');
  assert.equal(f.reports.length, 1, 'the loop records that no account can run the master');
  assert.equal(f.reports[0].key, 'GY-4010');
  const rows = openHumanOnly(f.work().map(item => ({ work: item })), f.now());
  assert.equal(rows.length, 1, 'the item is listed under humanOnly');
  assert.equal(rows[0].work, 'GY-4010');
  assert.equal(rows[0].request.needed, detail, 'the row carries the action detail');
});
