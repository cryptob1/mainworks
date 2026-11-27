import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { plannerPrompt } from '../src/daemon/planner.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master/profiles.js';
import { runPlanner } from '../src/master/planner.js';
import { recordTestSelection, readTestSelections, testSelectionSummary } from '../src/merge-writer/test-selection.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

const proof = 'integration:planner-sees-delivered';
const now = Date.parse('2026-11-25T14:30:00Z');
const hour = 60 * 60_000;
const day = 24 * hour;

function makeWork(key: string, overrides: Partial<Work> = {}): Work {
  const createdAt = new Date(now - 2 * day).toISOString();
  return workFixture({ key, title: 'Sample work', stage: 'backlog', ready: false, criteria: [], gates: [], sessions: [],
    createdAt, updatedAt: createdAt, stageEnteredAt: createdAt, ...overrides });
}

test(`${proof} — planner prompt lists items delivered in the last 7 days under their own heading beside open items and labels testSelection shares of reachable and of all tests`, async () => {
  const directory = await temporaryDirectory('planner-sees-delivered');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  await recordTestSelection(directory, { selected: 6, reachable: 8, all: 12, key: 'GY-3838', files: ['tests/a.test.ts'] });
  const selection = testSelectionSummary(readTestSelections(directory));
  assert.deepEqual(selection, { trials: 1, medianShareSelected: '75%', medianShareOfAllSelected: '50%', medianShareOfAll: { before: '50%', after: null } });

  // Direct plannerPrompt check with delivered items and testSelection.
  const direct = plannerPrompt({
    brief: 'Keep the line fed.',
    flow6h: null,
    slowestTrialFiles: [],
    testSelection: selection,
    openTitles: ['GY-3841: Wait on sshd stderr'],
    deliveredTitles: ['GY-3838: Record per-file trial test timings'],
  });
  assert.ok(direct.includes('Currently open items'), 'prompt has open items heading');
  assert.ok(direct.includes('GY-3841: Wait on sshd stderr'), 'prompt lists open item');
  assert.match(direct, /delivered in the last (?:7|seven) days/i, 'prompt has its own heading for recently delivered items');
  assert.ok(direct.includes('GY-3838: Record per-file trial test timings'), 'prompt lists delivered item key and title');
  assert.match(direct, /75%\s+of reachable/i, 'prompt labels median selection share of reachable tests');
  assert.match(direct, /50%\s+of all tests/i, 'prompt labels median selection share of all tests');

  // Full cycle -> plannerStep -> runPlanner check: includes <= 7d delivered, excludes > 7d delivered and closed items.
  const work: Work[] = [
    makeWork('GY-3841', { title: 'Wait on sshd stderr', stage: 'backlog', ready: false }),
    makeWork('GY-3838', {
      title: 'Record per-file trial test timings',
      stage: 'done',
      stageEnteredAt: new Date(now - 3 * hour).toISOString(),
      delivery: { mergedAt: new Date(now - 3 * hour).toISOString(), mergeSha: 'a'.repeat(40), authorizationRevision: 1 },
    }),
    makeWork('GY-3700', {
      title: 'Old delivered item past seven days',
      stage: 'done',
      stageEnteredAt: new Date(now - 8 * day).toISOString(),
      delivery: { mergedAt: new Date(now - 8 * day).toISOString(), mergeSha: 'c'.repeat(40), authorizationRevision: 1 },
    }),
    makeWork('GY-3842', {
      title: 'Closed duplicate not delivered',
      stage: 'done',
      stageEnteredAt: new Date(now - 1 * hour).toISOString(),
      closure: { kind: 'duplicate', reason: 'Duplicate of GY-3838', at: new Date(now - 1 * hour).toISOString(), by: 'lead', ref: 'GY-3838' } as Work['closure'],
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
    repository: 'owner/planner-sees-delivered',
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

  // Low-water / empty-board trigger launches the planner on the first cycle with free slots.
  clock += 15 * 60_000;
  await runCycle(config, state, effects, () => clock);

  assert.equal(prompts.length, 1, 'planner ran once');
  const prompt = prompts[0]!;
  assert.ok(prompt.includes('GY-3841: Wait on sshd stderr'), 'cycle prompt lists open item');
  assert.match(prompt, /delivered in the last (?:7|seven) days/i, 'cycle prompt has delivered heading');
  assert.ok(prompt.includes('GY-3838: Record per-file trial test timings'), 'cycle prompt lists recently delivered item');
  assert.ok(!prompt.includes('GY-3700'), 'cycle prompt excludes items delivered more than 7 days ago');
  assert.ok(!prompt.includes('GY-3842'), 'cycle prompt excludes closed non-delivered items');
  assert.match(prompt, /75%\s+of reachable/i, 'cycle prompt states selection share of reachable');
  assert.match(prompt, /50%\s+of all tests/i, 'cycle prompt states selection share of all tests');
});
