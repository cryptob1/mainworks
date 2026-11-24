import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { isEmptyBoardAlarm, stallAlarmKey } from '../src/daemon/stall-alarm.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const proof = 'integration:empty-board-wakes-lead';
const start = Date.parse('2026-11-24T08:00:00Z');
const minute = 60_000;

function makeWork(key: string, overrides: Partial<Work> = {}): Work {
  const updatedAt = new Date(start).toISOString();
  return {
    id: `id-${key}`,
    key,
    title: 'Sample work',
    stage: 'ready',
    ready: true,
    epoch: 0,
    revision: 1,
    policyRevision: 1,
    priority: 1,
    type: 'feature',
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['e2e:fixture'] }],
    dependencies: [],
    evidence: [],
    gates: [],
    workspaces: [],
    sessions: [],
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  } as unknown as Work;
}

function workerProfiles(count: number): WorkerProfile[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `w${i + 1}`,
    principal: `worker-${i + 1}`,
    agentName: `agent-w${i + 1}`,
    mode: 'launch',
    kind: 'claude',
    credentialFile: `/outside/w${i + 1}.token`,
    agentArgs: [],
    environment: {},
  } as unknown as WorkerProfile));
}

async function fixture(options: {
  work?: Work[];
  workers?: number;
  masterPresent?: boolean;
  allowLaunches?: boolean;
} = {}) {
  const directory = await temporaryDirectory('empty-board-wakes-lead');
  const workers = workerProfiles(options.workers ?? 4);
  const config: MasterConfig = masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    repository: 'owner/empty-board',
    credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard',
    hostId: 'empty-host',
    baseBranch: 'main',
    githubAppId: 1234,
    masterAgentName: 'master',
    workers,
  });
  const state = emptyDaemonState(config);
  state.lock = {
    id: 'lock',
    pid: 1,
    host: 'empty-host',
    startedAt: new Date(start).toISOString(),
    heartbeatAt: new Date(start).toISOString(),
  };
  let now = start;
  let work = options.work ?? [];
  let masterPresent = options.masterPresent ?? true;
  const wakes: string[] = [];
  const launches: string[] = [];
  const dispatched: string[] = [];

  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    agents: () => (masterPresent ? [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }] : []),
    credentials: async () =>
      Object.fromEntries(
        workers.map(w => [
          w.name,
          options.allowLaunches
            ? { available: true, reason: null }
            : { available: false, reason: 'held by the test' },
        ]),
      ),
    closeSession: () => {},
    persist: async () => {},
    dispatch: async item => {
      dispatched.push(item.key);
      work = work.map(entry =>
        entry.key === item.key
          ? ({
              ...entry,
              stage: 'build',
              lease: { owner: 'worker-1', epoch: 1, expiresAt: new Date(now + 60 * minute).toISOString() },
              sessions: [
                {
                  id: 'worker-1:1',
                  kind: 'implementation',
                  state: 'running',
                  principal: 'worker-1',
                  host: 'empty-host',
                  startedAt: new Date(now).toISOString(),
                },
              ],
            } as unknown as Work)
          : entry,
      );
      return { pane: 'p1', epoch: 1 };
    },
    masterSession: {
      wake: async (_target, text) => {
        wakes.push(text);
      },
      launch: async text => {
        launches.push(text);
        masterPresent = true;
        return { agentName: 'master', pane: 'pM', runtime: 'codex', account: 'a', session: 's' };
      },
    },
  };

  return {
    config,
    state,
    wakes,
    launches,
    dispatched,
    now: () => now,
    setWork: (next: Work[]) => {
      work = next;
    },
    cycle: () => runCycle(config, state, effects, () => now),
    advance: (minutes: number) => {
      now += minutes * minute;
    },
  };
}

async function status(config: MasterConfig, state: DaemonState, work: Work[]) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('empty-board-status');
  execFileSync('git', ['init', '-q', root]);
  const run = async (command: string, args: string[]) =>
    isHerdrCommand(command)
      ? herdrSubcommand(args)[1] === 'list'
        ? JSON.stringify({ agents: [] })
        : ''
      : `${'c'.repeat(40)}\n`;
  return masterStatusReport(
    root,
    config,
    (async (path: string) => (path === 'work-snapshot' ? { work, now: new Date().toISOString() } : { messages: [] })) as any,
    run,
  );
}

const alarmOf = (state: DaemonState) => state.actions[stallAlarmKey]?.detail;

test(`${proof} — empty board with 3+ free builder slots for 15 min raises stallAlarm in master status, wakes master at most once per 30 min, and clears when an item is released or a builder starts`, async () => {
  const f = await fixture({ work: [], workers: 4 });

  // Before 15 minutes: no alarm and no wake.
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined);
  assert.equal(f.wakes.length, 0);

  f.advance(14);
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'no alarm before 15 minutes');
  assert.equal(f.wakes.length, 0);

  // At 15 minutes: stallAlarm fires, heads master status, and wakes the master once.
  f.advance(1);
  await f.cycle();
  const alarm = alarmOf(f.state) ?? '';
  assert.ok(alarm, 'empty board for 15 minutes with 4 free builder slots raises stallAlarm');
  assert.match(alarm, /no work/i, 'cause says the line has no work');
  assert.match(alarm, /4 free builder slot/i, 'alarm names the free builder slots');

  const report = await status(f.config, f.state, []);
  assert.equal(Object.keys(report)[0], 'stallAlarm', 'stallAlarm heads master status');
  assert.equal(report.stallAlarm, alarm);

  assert.equal(f.wakes.length, 1, 'master is woken once when the empty-board alarm fires');
  assert.match(f.wakes[0], /board is empty/i, 'wake input says the board is empty');
  assert.match(f.wakes[0], /file.*work.*brief|brief/i, 'wake input asks to file work from the brief');

  // Within 30 minutes while empty: no second wake.
  f.advance(10);
  await f.cycle();
  f.advance(19);
  await f.cycle();
  assert.equal(f.wakes.length, 1, 'at most one wake per 30 minutes while empty');

  // After 30 minutes: wakes again.
  f.advance(1);
  await f.cycle();
  assert.equal(f.wakes.length, 2, 'wakes again once 30 minutes pass while still empty');

  // Releasing an item clears the alarm.
  const released = makeWork('GY-10', { ready: true, stage: 'ready', updatedAt: new Date(f.now()).toISOString() });
  f.setWork([released]);
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'alarm clears once an item is released');
  assert.equal((await status(f.config, f.state, [released])).stallAlarm, null);

  // Return to empty board past 15 min -> alarm returns; starting a builder clears it.
  f.setWork([]);
  f.advance(16);
  await f.cycle();
  assert.ok(alarmOf(f.state), 'alarm raises again when empty for 15 minutes');

  const building = makeWork('GY-11', {
    ready: true,
    stage: 'build',
    sessions: [
      {
        id: 'worker-1:1',
        kind: 'implementation',
        state: 'running',
        principal: 'worker-1',
        host: 'empty-host',
        startedAt: new Date(f.now()).toISOString(),
      },
    ],
  } as Partial<Work>);
  f.setWork([building]);
  await f.cycle();
  assert.equal(alarmOf(f.state), undefined, 'alarm clears once a builder starts');
});

test(`${proof} — launches the master session when absent with the empty-board input`, async () => {
  const f = await fixture({ work: [], workers: 4, masterPresent: false });
  f.advance(15);
  await f.cycle();

  assert.ok(f.state.actions[stallAlarmKey]?.detail, 'empty-board alarm is raised');
  assert.equal(f.launches.length, 1, 'absent master session is launched');
  assert.match(f.launches[0], /board is empty/i, 'launch input says the board is empty');
  assert.match(f.launches[0], /file.*work.*brief|brief/i, 'launch input asks to file work from the brief');
});

test(`${proof} — no empty-board alarm or wake when one ready item exists, when releasable backlog work exists, or when fewer than three builder slots are free`, async () => {
  // One ready item exists (and launches cleanly).
  const withReady = await fixture({ work: [makeWork('GY-20')], workers: 4, allowLaunches: true });
  await withReady.cycle();
  assert.deepEqual(withReady.dispatched, ['GY-20']);
  withReady.advance(10);
  await withReady.cycle();
  assert.equal(withReady.state.actions[stallAlarmKey], undefined, 'no alarm when a ready item exists and starts');
  assert.equal(withReady.wakes.length, 0, 'no wake when one ready item exists');

  // Unreleased-but-releasable backlog item exists.
  const releasable = makeWork('GY-21', { ready: false, stage: 'backlog' });
  const withReleasable = await fixture({ work: [releasable], workers: 4 });
  withReleasable.advance(20);
  await withReleasable.cycle();
  assert.equal(withReleasable.state.actions[stallAlarmKey], undefined, 'no alarm when releasable backlog work exists');
  assert.equal(withReleasable.wakes.length, 0);

  // Fewer than 3 free builder slots.
  const twoSlots = await fixture({ work: [], workers: 2 });
  twoSlots.advance(20);
  await twoSlots.cycle();
  assert.equal(twoSlots.state.actions[stallAlarmKey], undefined, 'no alarm with fewer than three free builder slots');
  assert.equal(twoSlots.wakes.length, 0);
});

test(`${proof} — no empty-board alarm or wake while a released item is still open at review, test or merge, or held, with no running builder`, async () => {
  for (const overrides of [
    { stage: 'review' },
    { stage: 'test' },
    { stage: 'merge' },
    { stage: 'build', hold: { reason: 'held by the test' } },
  ] as Partial<Work>[]) {
    const f = await fixture({ work: [makeWork('GY-30', { ready: true, ...overrides })], workers: 4 });
    await f.cycle();
    f.advance(20);
    await f.cycle();
    assert.ok(!isEmptyBoardAlarm(alarmOf(f.state) ?? ''), `no empty-board alarm with a released item at ${overrides.stage}${overrides.hold ? ' on hold' : ''}`);
    assert.ok(![...f.wakes, ...f.launches].some(text => /board is empty/i.test(text)), `no empty-board wake with a released item at ${overrides.stage}`);
  }
});
