import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { plannerPrompt } from '../src/daemon/planner.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { runPlanner } from '../src/master/planner.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

const proof = 'integration:planner-sees-rejected';
const now = Date.parse('2026-11-26T14:30:00Z');
const hour = 60 * 60_000;
const day = 24 * hour;

function makeWork(key: string, overrides: Partial<Work> = {}): Work {
  const createdAt = new Date(now - 2 * day).toISOString();
  return workFixture({ key, title: 'Sample work', stage: 'backlog', ready: false, criteria: [], gates: [], sessions: [], createdAt, updatedAt: createdAt, stageEnteredAt: createdAt, ...overrides });
}

test(`${proof} — planner prompt lists planner drafts closed in the last 7 days with their close reasons under their own heading`, async () => {
  const directory = await temporaryDirectory('planner-sees-rejected');
  const closedTitle = 'Parallelize trial fixtures';
  const closeReason = 'Already covered by shard splitting in GY-3880';

  // Direct plannerPrompt check with one closed planner draft.
  const direct = plannerPrompt({
    brief: 'Keep the line fed.',
    flow6h: null,
    slowestTrialFiles: [],
    openTitles: ['GY-3912: Keep worker leases warm'],
    closedDrafts: [`GY-3899: ${closedTitle} — ${closeReason}`],
  });
  assert.match(direct, /closed in the last (?:7|seven) days/i, 'prompt has its own heading for recently closed planner drafts');
  assert.ok(direct.includes(closedTitle), 'prompt includes closed draft title');
  assert.ok(direct.includes(closeReason), 'prompt includes close reason');

  // Full cycle -> plannerStep -> runPlanner check: includes <= 7d closed planner drafts,
  // excludes > 7d closed planner drafts and non-planner closed items.
  const work: Work[] = [
    makeWork('GY-3912', { title: 'Keep worker leases warm', stage: 'backlog', ready: false }),
    makeWork('GY-3899', {
      title: closedTitle,
      origin: 'planner',
      stage: 'done',
      stageEnteredAt: new Date(now - 2 * hour).toISOString(),
      closure: { kind: 'obsolete', reason: closeReason, ref: null, at: new Date(now - 2 * hour).toISOString(), by: 'lead', from: 'backlog' },
    }),
    makeWork('GY-3701', {
      title: 'Old closed planner draft past seven days',
      origin: 'planner',
      stage: 'done',
      stageEnteredAt: new Date(now - 8 * day).toISOString(),
      closure: { kind: 'obsolete', reason: 'Too old to matter', ref: null, at: new Date(now - 8 * day).toISOString(), by: 'lead', from: 'backlog' },
    }),
    makeWork('GY-3901', {
      title: 'Non-planner item closed recently',
      stage: 'done',
      stageEnteredAt: new Date(now - 1 * hour).toISOString(),
      closure: { kind: 'obsolete', reason: 'Operator closed manually', ref: null, at: new Date(now - 1 * hour).toISOString(), by: 'lead', from: 'backlog' },
    }),
  ];

  const workers: WorkerProfile[] = Array.from({ length: 4 }, (_, i) => ({
    name: `w${i + 1}`,
    principal: `worker-${i + 1}`,
    agentName: `agent-w${i + 1}`,
    mode: 'launch',
    kind: 'claude',
    credentialFile: `/outside/w${i + 1}.token`,
    agentArgs: [],
    environment: {},
  } as unknown as WorkerProfile));
  const config: MasterConfig = masterConfigSchema.parse({
    version: 1,
    url: 'https://mainworks.example',
    repository: 'owner/planner-sees-rejected',
    credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/mainworks',
    hostId: 'planner-host',
    baseBranch: 'main',
    githubAppId: 1234,
    masterAgentName: 'master',
    workers,
  });
  const state = emptyDaemonState(config);
  let clock = now - 45 * 60_000;
  state.lock = { id: 'lock', pid: 1, host: 'planner-host', startedAt: new Date(clock).toISOString(), heartbeatAt: new Date(clock).toISOString() };
  state.projectMemory.brief = { markdown: 'Keep the line fed.', updatedAt: new Date(clock).toISOString(), by: 'lead', why: 'seed', history: [] };

  const prompts: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(clock).toISOString() }),
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
        headless: async (_command, args, options) => {
          prompts.push(options.stdin ?? args.at(-1) ?? '');
          return '[]';
        },
        createWork: async () => ({ key: 'GY-4001' }),
      }),
  };

  clock += 15 * 60_000;
  await runCycle(config, state, effects, () => clock);

  assert.equal(prompts.length, 1, 'planner ran once');
  const prompt = prompts[0]!;
  assert.match(prompt, /closed in the last (?:7|seven) days/i, 'cycle prompt has closed drafts heading');
  assert.ok(prompt.includes(`GY-3899: ${closedTitle}`), 'cycle prompt lists recently closed planner draft');
  assert.ok(prompt.includes(closeReason), 'cycle prompt includes close reason');
  assert.ok(!prompt.includes('GY-3701'), 'cycle prompt excludes planner drafts closed more than 7 days ago');
  assert.ok(!prompt.includes('GY-3901'), 'cycle prompt excludes non-planner closed items');
});
