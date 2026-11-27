import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master/profiles.js';
import { runPlanner } from '../src/master/planner.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const proof = 'integration:planner-low-water';
const start = Date.parse('2026-11-25T10:00:00Z');
const minute = 60_000;

function makeWork(key: string, overrides: Partial<Work> = {}): Work {
  const createdAt = new Date(start).toISOString();
  return {
    id: `id-${key}`,
    key,
    title: `Work ${key}`,
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

async function fixture(options: { work: Work[]; workers?: number }) {
  const directory = await temporaryDirectory('planner-low-water');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const workers = workerProfiles(options.workers ?? 4);
  const config: MasterConfig = masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    repository: 'owner/planner-low-water',
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
    markdown: 'Keep the line fed without 30-minute idle gaps.',
    updatedAt: new Date(start).toISOString(),
    by: 'lead',
    why: 'seed',
    history: [],
  };

  let now = start;
  let work = options.work;
  let nextNum = 4100;
  const prompts: string[] = [];
  const createdPayloads: Record<string, unknown>[] = [];
  const plannerOutput = JSON.stringify([
    { title: 'Draft item one', why: 'Keeps builders fed.', simplest: 'Smallest change one.' },
    { title: 'Draft item two', why: 'Cuts queue drain.', simplest: 'Smallest change two.' },
    { title: 'Draft item three', why: 'Lifts merge rate.', simplest: 'Smallest change three.' },
    { title: 'Draft item four over cap', why: 'Must be dropped.', simplest: 'Over the three-draft cap.' },
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
      runPlanner(directory, config, input, {
        flow: async () => null,
        select: async () => ({
          account: { name: 'planner-acct', kind: 'claude', environment: {} } as any,
          health: null,
          skipped: [],
          release: async () => true,
        }),
        headless: async (_command, args, opts) => {
          prompts.push(opts.stdin ?? args.at(-1) ?? '');
          return plannerOutput;
        },
        createWork: async payload => {
          createdPayloads.push(payload);
          const key = `GY-${++nextNum}`;
          const item = makeWork(key, {
            title: String(payload.title),
            why: String(payload.why),
            simplest: String(payload.simplest),
            stage: 'backlog',
            ready: false,
            criteria: [],
            origin: payload.origin as Work['origin'],
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          });
          work = [...work, item];
          return { key };
        },
      }),
  };

  return {
    prompts,
    createdPayloads,
    work: () => work,
    cycle: () => runCycle(config, state, effects, () => now),
    advance: (minutes: number) => { now += minutes * minute; },
  };
}

test(`${proof} — two ready items with free builder slots launches one planner session under the 2-hour cooldown and 3-draft cap`, async () => {
  const f = await fixture({ work: [makeWork('GY-501'), makeWork('GY-502')], workers: 4 });

  await f.cycle();
  assert.equal(f.prompts.length, 1, 'launches one planner session when two ready items exist with free builder slots');
  assert.equal(f.createdPayloads.length, 3, 'caps filed planner drafts at three');

  // Within the 2-hour cooldown: no second planner launch.
  f.advance(60);
  await f.cycle();
  f.advance(59);
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'does not launch a second planner session within the two-hour cooldown');
});

test(`${proof} — three ready items with free builder slots does not launch the planner`, async () => {
  const f = await fixture({ work: [makeWork('GY-501'), makeWork('GY-502'), makeWork('GY-503')], workers: 4 });

  await f.cycle();
  assert.equal(f.prompts.length, 0, 'no planner launch when three ready items exist');
  assert.equal(f.createdPayloads.length, 0, 'no draft filed when three ready items exist');
});

function runningSession(id: string): NonNullable<Work['sessions']>[number] {
  return {
    id,
    kind: 'implementation',
    principal: 'worker-1',
    runtime: 'claude',
    host: 'planner-host',
    subject: id,
    state: 'running',
    startedAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
  } as unknown as NonNullable<Work['sessions']>[number];
}

test(`${proof} — two ready items with no free builder slots does not launch the planner`, async () => {
  const activeLease = { owner: 'worker-1', epoch: 1, expiresAt: new Date(start + 30 * minute).toISOString() };
  const f = await fixture({
    workers: 2,
    work: [
      makeWork('GY-501'),
      makeWork('GY-502'),
      makeWork('GY-503', { stage: 'build', lease: activeLease, sessions: [runningSession('w1:1')] }),
      makeWork('GY-504', { stage: 'build', lease: activeLease, sessions: [runningSession('w2:1')] }),
    ],
  });

  await f.cycle();
  assert.equal(f.prompts.length, 0, 'no planner launch when all builder slots are occupied');
});

test(`${proof} — counts released-and-unclaimed items and excludes actively claimed items`, async () => {
  const releasedUnclaimed = makeWork('GY-503', { stage: 'build', ready: true, lease: null, sessions: [] });
  const threeUnclaimed = await fixture({
    workers: 4,
    work: [makeWork('GY-501'), makeWork('GY-502'), releasedUnclaimed],
  });
  await threeUnclaimed.cycle();
  assert.equal(threeUnclaimed.prompts.length, 0, 'three ready/released-and-unclaimed items stay above the low-water mark');

  const claimed = makeWork('GY-503', {
    stage: 'build',
    ready: true,
    lease: { owner: 'worker-1', epoch: 1, expiresAt: new Date(start + 30 * minute).toISOString() },
    sessions: [runningSession('w1:1')],
  });
  const twoUnclaimed = await fixture({
    workers: 4,
    work: [makeWork('GY-501'), makeWork('GY-502'), claimed],
  });
  await twoUnclaimed.cycle();
  assert.equal(twoUnclaimed.prompts.length, 1, 'claimed item does not count toward the ready low-water mark');
});
