import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { plannerPrompt, recentlyDeliveredTitles } from '../src/daemon/planner.js';
import { flowNumbers } from '../src/flow-numbers.js';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master/profiles.js';
import { runPlanner } from '../src/master/planner.js';
import type { Work } from '../src/model.js';
import { flowItems, type FlowReport } from '../src/server/flow.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-4069: the planner prompt says how long ago each delivered item merged and each failing check
// last failed, with the 24-hour flow beside the 6-hour one. A draft then sees that the failure it
// would second-guess is older than the fix that already merged.
const proof = 'unit:planner-prompt-shows-ages';
const minute = 60_000;

/** The line of `text` that starts with `label`. */
const line = (text: string, label: string) => text.split('\n').find(entry => entry.startsWith(label));

/**
 * GY-4063 healed tests/stale.test.ts and merged an hour before `base`; its trial five hours before
 * `base` failed that file and tests/day.test.ts. GY-4100, still in test, failed tests/live.test.ts
 * 40 minutes before `base`, after that fix, and tests/day.test.ts 700 minutes before it.
 */
function history(base: number) {
  const at = (minutesAgo: number) => new Date(base - minutesAgo * minute).toISOString();
  const trial = (work_id: string, seq: number, minutesAgo: number, failed: string[], assertions: Record<string, string> = {}) =>
    ({ work_id, seq, kind: 'merge.trial', created_at: at(minutesAgo), stage: null, head: `h${seq}`, duration_ms: 60_000, flaked: false, trial: { flaked: null, failed, assertions } });
  const delivered = workFixture({ key: 'GY-4063', title: 'Heal tests/stale.test.ts', stage: 'done', stageEnteredAt: at(60),
    delivery: { mergedAt: at(60), mergeSha: 'a'.repeat(40), authorizationRevision: 1 } });
  const open = workFixture({ key: 'GY-4100', title: 'Keep the trial ledger plain', stage: 'test', stageEnteredAt: at(100), submission: { epoch: 1, pr: 7 } });
  const ledger = [
    trial('id-GY-4063', 1, 300, ['tests/stale.test.ts', 'tests/day.test.ts'], { 'tests/stale.test.ts': 'the stale line' }),
    trial('id-GY-4100', 2, 700, ['tests/day.test.ts']),
    trial('id-GY-4100', 3, 40, ['tests/live.test.ts'], { 'tests/live.test.ts': 'the marker was not written' }),
  ];
  const items = flowItems([delivered, open], ledger, new Map(), new Map(), base);
  const flow = (hours: number) => flowNumbers(items, hours, base);
  return { work: [delivered, open] as Work[], six: flow(6), day: flow(24), week: flow(168) };
}

const deliveredLine = '- GY-4063: Heal tests/stale.test.ts (merged 1h ago)';
const sixHourFlow = '6-hour flow: 0.2 merges/h (1 merges), 0.0 attempts/h (0 attempts), first-pass yield —, trials 2, flaky 0 (0%), reverts 0.';
const dayFlow = '24-hour flow: 0.0 merges/h (1 merges), 0.0 attempts/h (0 attempts), first-pass yield —, trials 3, flaky 0 (0%), reverts 0.';
const sixHourFailing = 'Failing checks (6h): tests/stale.test.ts 1, last failed 5h ago, candidate-only; newest GY-4063 head h1 base unavailable; latest main result unavailable (the stale line); tests/day.test.ts 1, last failed 5h ago, candidate-only; newest GY-4063 head h1 base unavailable; latest main result unavailable; tests/live.test.ts 1, last failed 40m ago, candidate-only; newest GY-4100 head h3 base unavailable; latest main result unavailable (the marker was not written).';
const dayFailing = 'Failing checks (24h): tests/day.test.ts 2, last failed 5h ago, candidate-only; newest GY-4063 head h1 base unavailable; latest main result unavailable; tests/stale.test.ts 1, last failed 5h ago, candidate-only; newest GY-4063 head h1 base unavailable; latest main result unavailable (the stale line); tests/live.test.ts 1, last failed 40m ago, candidate-only; newest GY-4100 head h3 base unavailable; latest main result unavailable (the marker was not written).';

test(`${proof} — the prompt gives each delivered item's and each failing check's age, the 24-hour flow beside the 6-hour one`, () => {
  const now = Date.parse('2026-11-27T14:30:00Z');
  const { work, six, day } = history(now);
  const input = { brief: 'Keep the line fed.', flow6h: six, flow24h: day, slowestTrialFiles: [], openTitles: [], deliveredTitles: recentlyDeliveredTitles(work, now), now } as const;
  const prompt = plannerPrompt(input);

  assert.ok(prompt.includes(deliveredLine), `the delivered item says how long ago it merged:\n${prompt}`);
  assert.equal(line(prompt, '6-hour flow: '), sixHourFlow);
  assert.equal(line(prompt, 'Failing checks (6h): '), sixHourFailing, `each failing check of the 6 hours says how long ago it last failed:\n${prompt}`);
  assert.equal(line(prompt, '24-hour flow: '), dayFlow);
  assert.equal(line(prompt, 'Failing checks (24h): '), dayFailing, `each failing check of the day says how long ago it last failed:\n${prompt}`);
  // Beside: the day's block (its flow, rework causes and failing checks) follows the 6-hour one directly.
  const lines = prompt.split('\n');
  assert.equal(lines.indexOf(dayFlow), lines.indexOf(sixHourFlow) + 3, 'the 24-hour flow sits right after the 6-hour block');
  // The prompt stays a pure function of its inputs: the same inputs render byte-identical, and a 24-hour input that adds nothing (null or absent) changes nothing.
  assert.equal(plannerPrompt(input), prompt, 'the same inputs render byte-identical');
  assert.equal(plannerPrompt({ ...input, flow24h: null }), plannerPrompt({ ...input, flow24h: undefined }), 'a null and an absent 24-hour flow read the same');
});

test(`integration:planner-prompt-shows-ages — a planner cycle hands the session the ages and the 24-hour flow`, async () => {
  // The cycle builds the prompt with the real clock, so the fixture's times are relative to it.
  const base = Date.now();
  const { work, six, day, week } = history(base);
  const directory = await temporaryDirectory('planner-prompt-shows-ages');
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
    repository: 'owner/planner-prompt-shows-ages',
    credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/mainworks',
    hostId: 'planner-host',
    baseBranch: 'main',
    githubAppId: 1234,
    masterAgentName: 'master',
    workers,
  });
  const stamp = new Date(base).toISOString();
  const state = emptyDaemonState(config);
  state.lock = { id: 'lock', pid: 1, host: 'planner-host', startedAt: stamp, heartbeatAt: stamp };
  state.projectMemory.brief = { markdown: 'Keep the line fed.', updatedAt: stamp, by: 'lead', why: 'seed', history: [] };
  const report: FlowReport = { asOf: stamp, ageSeconds: 0, onboarding: [], attention: null, '6h': six, '24h': day, '7d': week };

  const prompts: string[] = [];
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: stamp }),
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
        flow: async () => report,
        workSnapshot: async () => ({ work, now: stamp }),
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
        createWork: async () => ({ key: 'GY-4200' }),
      }),
  };

  // One item in test and free builder slots: the low-water trigger launches the planner on the first cycle.
  await runCycle(config, state, effects, () => base);

  assert.equal(prompts.length, 1, 'planner ran once');
  const prompt = prompts[0]!;
  assert.ok(prompt.includes(deliveredLine), `the cycle prompt says how long ago the delivered item merged:\n${prompt}`);
  assert.equal(line(prompt, '6-hour flow: '), sixHourFlow);
  assert.equal(line(prompt, 'Failing checks (6h): '), sixHourFailing);
  assert.equal(line(prompt, '24-hour flow: '), dayFlow, `the cycle prompt gives the 24-hour flow:\n${prompt}`);
  assert.equal(line(prompt, 'Failing checks (24h): '), dayFailing);
});
