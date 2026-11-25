import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { runPlanner } from '../src/master/planner.js';
import type { FlowReport } from '../src/server/flow.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const proof = 'integration:planner-drafts-on-empty-board';
const start = Date.parse('2026-11-25T08:00:00Z');
const minute = 60_000;

function makeWork(key: string, overrides: Partial<Work> = {}): Work {
  const createdAt = new Date(start).toISOString();
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
    createdAt,
    updatedAt: createdAt,
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

const sampleFlow: FlowReport = {
  asOf: new Date(start).toISOString(),
  ageSeconds: 12,
  attention: null,
  '6h': {
    hours: 6,
    attempts: 18,
    attemptsPerHour: 3,
    merges: 12,
    mergesPerHour: 2,
    firstPassYield: 0.67,
    rework: { review: 2, 'product review': 1, 'merge trial': 4, acceptance: 0, 'base moved': 3, 'red base': 1 }, reviewReasons: [],
    stations: {
      ready: { median: 2, p90: 5, samples: 12, oldest: { key: 'GY-1', title: 'Old', minutes: 5, waiting: false } },
      build: { median: 14, p90: 28, samples: 12, oldest: { key: 'GY-1', title: 'Old', minutes: 28, waiting: false } },
      review: { median: 4, p90: 9, samples: 12, oldest: { key: 'GY-1', title: 'Old', minutes: 9, waiting: false } },
      'test queue': { median: 6, p90: 15, samples: 12, oldest: { key: 'GY-1', title: 'Old', minutes: 15, waiting: false } },
      'merge trial': { median: 8, p90: 14, samples: 12, oldest: { key: 'GY-1', title: 'Old', minutes: 14, waiting: false } },
      acceptance: null,
      'waiting for sign-off': null,
      'waiting for the merge writer': null,
      merge: null,
      live: null,
    },
    trials: 16,
    flaky: 2,
    flakyRate: 0.125,
    reverts: 0,
    revertRate: 0,
  },
  '24h': {
    hours: 24, attempts: 40, attemptsPerHour: 1.7, merges: 30, mergesPerHour: 1.25, firstPassYield: 0.75,
    rework: { review: 3, 'product review': 1, 'merge trial': 5, acceptance: 0, 'base moved': 4, 'red base': 1 }, reviewReasons: [],
    stations: { ready: null, build: null, review: null, 'test queue': null, 'merge trial': null, acceptance: null, 'waiting for sign-off': null, 'waiting for the merge writer': null, merge: null, live: null },
    trials: 35, flaky: 2, flakyRate: 0.057, reverts: 0, revertRate: 0,
  },
  '7d': {
    hours: 168, attempts: 200, attemptsPerHour: 1.2, merges: 150, mergesPerHour: 0.9, firstPassYield: 0.75,
    rework: { review: 10, 'product review': 2, 'merge trial': 20, acceptance: 1, 'base moved': 15, 'red base': 2 }, reviewReasons: [],
    stations: { ready: null, build: null, review: null, 'test queue': null, 'merge trial': null, acceptance: null, 'waiting for sign-off': null, 'waiting for the merge writer': null, merge: null, live: null },
    trials: 180, flaky: 5, flakyRate: 0.028, reverts: 1, revertRate: 0.007,
  },
};

const sampleBrief = '## Problem\nKeep the line fed overnight without manual drafting.\n## What success looks like\n4 to 6 merged changes an hour.';

async function fixture(options: {
  work?: Work[];
  workers?: number;
  plannerOutput?: string;
  createWork?: (payload: Record<string, unknown>) => Promise<{ key?: string } | null>;
} = {}) {
  const directory = await temporaryDirectory('planner-drafts-empty-board');
  const workers = workerProfiles(options.workers ?? 4);
  const config: MasterConfig = masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    repository: 'owner/planner-drafts',
    credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard',
    hostId: 'planner-host',
    baseBranch: 'main',
    githubAppId: 1234,
    masterAgentName: 'master',
    workers,
  });
  const state = emptyDaemonState(config);
  state.lock = {
    id: 'lock',
    pid: 1,
    host: 'planner-host',
    startedAt: new Date(start).toISOString(),
    heartbeatAt: new Date(start).toISOString(),
  };
  state.projectMemory.brief = {
    markdown: sampleBrief,
    updatedAt: new Date(start).toISOString(),
    by: 'lead',
    why: 'seed',
    history: [],
  };

  let now = start;
  let work = options.work ?? [];
  let nextNum = 4000;
  const prompts: string[] = [];
  const createdPayloads: Record<string, unknown>[] = [];
  const plannerOutput = options.plannerOutput ?? JSON.stringify([
    { title: 'Speed up slow trial test A', why: 'Cuts merge trial wait for every PR.', simplest: 'Split the slow test fixture.', criteria: [{ id: 'AC-1', text: 'Should be stripped', proofs: ['unit:x'] }] },
    { title: 'Reduce base-moved rework', why: 'Improves first-pass yield for builders.', simplest: 'Auto-sync before trial starts.' },
    { title: 'Fix flaky review timeout', why: 'Stops review retries from stalling merges.', simplest: 'Raise the idle probe grace by 10s.' },
    { title: 'Fourth draft over the cap', why: 'Must not be filed.', simplest: 'Should be dropped by the cap of 3.' },
    { title: 'Fifth draft over the cap', why: 'Also must not be filed.', simplest: 'Also dropped.' },
  ]);

  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    credentials: async () => Object.fromEntries(workers.map(w => [w.name, { available: true, reason: null }])),
    closeSession: () => {},
    persist: async () => {},
    dispatch: async () => ({ pane: 'p1', epoch: 1 }),
    masterSession: {
      wake: async () => {},
      launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'a', session: 's' }),
    },
    planner: input =>
      runPlanner(process.cwd(), config, input, {
        flow: async () => sampleFlow,
        select: async () => ({
          account: { name: 'planner-acct', kind: 'claude', environment: {} } as any,
          health: null,
          skipped: [],
          release: async () => true,
        }),
        headless: async (_command, args, options) => {
          prompts.push(options.stdin ?? args.at(-1) ?? '');
          return plannerOutput;
        },
        createWork: async payload => {
          createdPayloads.push(payload);
          if (options.createWork) return options.createWork(payload);
          const key = `GY-${++nextNum}`;
          const item = makeWork(key, {
            title: String(payload.title),
            why: String(payload.why),
            simplest: String(payload.simplest),
            stage: 'backlog',
            ready: false,
            criteria: (payload.criteria as Work['criteria']) ?? [],
            origin: payload.origin,
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          });
          work = [...work, item];
          return { key };
        },
      }),
  };

  return {
    config,
    state,
    prompts,
    createdPayloads,
    work: () => work,
    setWork: (next: Work[]) => { work = next; },
    cycle: () => runCycle(config, state, effects, () => now),
    advance: (minutes: number) => { now += minutes * minute; },
  };
}

async function status(config: MasterConfig, state: DaemonState, work: Work[]) {
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const root = await temporaryDirectory('planner-drafts-status');
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

test(`${proof} — empty-board alarm held 30 min launches one planner session with brief, 6h flow, rework causes and 5 slowest trial test files; files at most 3 unreleased drafts with why/simplest and no criteria; listed in master status attention`, async () => {
  const f = await fixture({ work: [], workers: 4 });

  // At 15 min: empty-board alarm raises, but has been held 0 min -> no planner launch.
  f.advance(15);
  await f.cycle();
  assert.ok(f.state.actions[stallAlarmKey]?.detail, 'empty-board alarm is raised at 15 min');
  assert.equal(f.prompts.length, 0, 'no planner launch when alarm just raised');

  // At 44 min (29 min of alarm): still no planner launch.
  f.advance(29);
  await f.cycle();
  assert.equal(f.prompts.length, 0, 'no planner launch before 30 min of empty-board alarm');

  // At 45 min (30 min of alarm): launches one planner session.
  f.advance(1);
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'launches one planner session after 30 min of empty-board alarm');

  const prompt = f.prompts[0]!;
  assert.ok(prompt.includes('Keep the line fed overnight without manual drafting.'), 'prompt contains the product brief');
  assert.match(prompt, /2\.0\s*merges\/h|merges.*12/i, 'prompt contains 6-hour flow numbers');
  assert.match(prompt, /merge trial:\s*4/i, 'prompt contains rework causes');
  assert.match(prompt, /base moved:\s*3/i, 'prompt contains rework causes');
  const testFileMatches = prompt.match(/tests\/[\w./-]+\.test\.ts/g) ?? [];
  assert.ok(new Set(testFileMatches).size >= 5, `prompt names the five slowest trial test files (found ${new Set(testFileMatches).size})`);

  // Cap of 3, each with why and simplest, reason for operator-agent mutation, no criteria, left unreleased.
  assert.equal(f.createdPayloads.length, 3, 'files at most three items despite five returned');
  for (const payload of f.createdPayloads) {
    assert.ok(typeof payload.reason === 'string' && payload.reason.trim().length > 0, 'planner draft create body includes a non-empty reason');
  }
  const drafts = f.work();
  assert.equal(drafts.length, 3);
  for (const draft of drafts) {
    assert.ok(draft.why && draft.why.length > 0, `${draft.key} has why`);
    assert.ok(draft.simplest && draft.simplest.length > 0, `${draft.key} has simplest`);
    assert.deepEqual(draft.criteria, [], `${draft.key} has no criteria`);
    assert.equal(draft.ready, false, `${draft.key} is left unreleased`);
    assert.equal(draft.stage, 'backlog', `${draft.key} stays in backlog`);
  }

  // AC-2: master status lists the planner drafts awaiting the Lead under attention with their keys.
  const report = await status(f.config, f.state, drafts);
  for (const draft of drafts) {
    const entry = report.attention.find(item => item.subject === draft.key || item.text.includes(draft.key));
    assert.ok(entry, `master status attention lists planner draft ${draft.key}`);
    assert.match(`${entry!.text} ${entry!.next}`, /criteria|requirements|close/i, `attention guides Lead to write criteria or close ${draft.key}`);
  }

  // Once the Lead writes criteria on one draft and closes another, only the remaining draft stays in planner attention.
  const updated = [
    { ...drafts[0]!, criteria: [{ id: 'AC-1', text: 'Lead wrote criteria', proofs: ['unit:a'] }] },
    { ...drafts[1]!, stage: 'done' as const },
    drafts[2]!,
  ];
  const afterLead = await status(f.config, f.state, updated);
  assert.equal(afterLead.attention.some(item => item.subject === drafts[0]!.key), false, 'draft with criteria leaves attention');
  assert.equal(afterLead.attention.some(item => item.subject === drafts[1]!.key), false, 'closed draft leaves attention');
  assert.equal(afterLead.attention.some(item => item.subject === drafts[2]!.key), true, 'remaining draft stays in attention');

  // Within 2 hours of filing planner drafts: no second planner launch.
  f.advance(60);
  await f.cycle();
  f.advance(59);
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'no second planner launch within 2 hours of a planner draft');
});

test(`${proof} — no planner launch when one ready item exists`, async () => {
  const f = await fixture({ work: [makeWork('GY-500')], workers: 4 });
  f.advance(60);
  await f.cycle();
  assert.equal(f.prompts.length, 0, 'no planner launch when one ready item exists');
  assert.equal(f.createdPayloads.length, 0, 'no draft filed when one ready item exists');
});

test(`${proof} — no planner launch when no operator-agent is configured`, async () => {
  const f = await fixture({ work: [], workers: 4 });
  const prodEffects = daemonEffects(process.cwd(), f.config, {
    snapshot: async () => ({ work: [], now: new Date(start).toISOString() }),
    mutate: async () => ({}),
  });
  assert.equal(prodEffects.planner, undefined, 'production effects omit planner when operatorAgent is not configured');

  let headlessCalled = false;
  const outcome = await runPlanner(process.cwd(), f.config, { brief: sampleBrief, openTitles: [] }, {
    headless: async () => { headlessCalled = true; return '[]'; },
    select: async () => { throw new Error('should not select an account without createWork'); },
  });
  assert.equal(headlessCalled, false, 'runPlanner does not launch a headless session without createWork');
  assert.ok('skipped' in outcome, 'runPlanner reports skipped without createWork');
});

test(`${proof} — refused create backs off instead of relaunching every 30 minutes`, async () => {
  const f = await fixture({
    work: [],
    workers: 4,
    createWork: async () => {
      throw new Error('Mainworks refused work (400): Operator-agent mutations require a reason');
    },
  });

  // Raise alarm at 15 min, then reach 30 min held at 45 min.
  f.advance(15);
  await f.cycle();
  f.advance(30);
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'initial planner launch runs at 30 min of empty-board alarm');
  assert.equal(f.state.planner?.failures, 1);
  assert.ok(f.state.planner?.nextAt, 'refused create records a backoff nextAt');

  // 30, 60, and 119 minutes later: must NOT relaunch.
  f.advance(30);
  await f.cycle();
  f.advance(30);
  await f.cycle();
  f.advance(59);
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'does not relaunch during 2-hour backoff after first refusal');

  // At 120 minutes after first refusal: retries once and backs off 4 hours on second refusal.
  f.advance(1);
  await f.cycle();
  assert.equal(f.prompts.length, 2, 'retries after 2-hour backoff expires');
  assert.equal(f.state.planner?.failures, 2);

  // 239 minutes later: still within 4-hour backoff.
  f.advance(239);
  await f.cycle();
  assert.equal(f.prompts.length, 2, 'doubles backoff to 4 hours after second consecutive refusal');
});
