import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import { fleetCommand } from '../src/cli/master/fleet.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import {
  loadStoredMasterConfig,
  masterConfigSchema,
  masterSettingsFromArgs,
  type MasterConfig,
  type WorkerProfile,
} from '../src/master.js';
import { runPlanner } from '../src/master/planner.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const proof = 'integration:planner-switch';
const start = Date.parse('2026-11-26T06:00:00Z');
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

async function setupInstall() {
  const scratch = await temporaryDirectory('planner-switch');
  const root = join(scratch, 'repo');
  mkdirSync(join(root, '.graphyard'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const credentialFile = join(scratch, 'operator.token');
  writeFileSync(credentialFile, 'operator-agent-token-'.padEnd(40, 'x'));
  chmodSync(credentialFile, 0o600);
  const coordinatorFile = join(scratch, 'coordinator.token');
  writeFileSync(coordinatorFile, 'coordinator-token-'.padEnd(40, 'y'));
  chmodSync(coordinatorFile, 0o600);

  const workers = workerProfiles(4);
  const initialConfig: MasterConfig = masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    repository: 'owner/planner-switch',
    credentialFile: coordinatorFile,
    cliPath: resolve('bin/graphyard.mjs'),
    hostId: 'planner-host',
    baseBranch: 'main',
    githubAppId: 1234,
    masterAgentName: 'master',
    workers,
    operatorAgent: { id: 'lead-operator', credentialFile },
  });
  const masterConfigPath = join(root, '.graphyard', 'master.json');
  writeFileSync(masterConfigPath, JSON.stringify(initialConfig, null, 2));
  chmodSync(masterConfigPath, 0o600);

  const runConfig = (args: string[], masterOverride?: MasterConfig) =>
    fleetCommand({
      id: 'config',
      args,
      root,
      master: masterOverride ?? initialConfig,
      print: (value: unknown) => value,
      coordinator: { actor: { id: 'graphyard-master-app' } },
    } as never);

  const readStatus = async (config: MasterConfig) =>
    masterStatusReport(
      root,
      config,
      async () => ({ work: [], now: new Date(start).toISOString() }),
      async () => '',
    );

  return { root, workers, initialConfig, runConfig, readStatus };
}

test(`${proof} — planner launches when on, does not launch when off under any board state, and launches again when restored`, async () => {
  const { root, workers, initialConfig, runConfig, readStatus } = await setupInstall();

  // Invalid values are refused.
  assert.throws(() => masterSettingsFromArgs(['planner=maybe']), /on or off/);

  // Without an operator-agent identity, planner=off is refused.
  const withoutOperator = { ...initialConfig, operatorAgent: undefined };
  await assert.rejects(runConfig(['planner=off'], withoutOperator), /operator-agent identity/);

  let now = start;
  let work: Work[] = [makeWork('GY-501')];
  let nextNum = 4100;
  let launches = 0;
  const createdPayloads: Record<string, unknown>[] = [];
  const plannerOutput = JSON.stringify([
    { title: 'Draft item', why: 'Keeps builders fed.', simplest: 'Smallest change.' },
  ]);

  const state = emptyDaemonState(initialConfig);
  state.lock = {
    id: 'lock',
    pid: 1,
    host: 'planner-host',
    startedAt: new Date(start).toISOString(),
    heartbeatAt: new Date(start).toISOString(),
  };
  state.projectMemory.brief = {
    markdown: 'Keep the line fed.',
    updatedAt: new Date(start).toISOString(),
    by: 'lead',
    why: 'seed',
    history: [],
  };

  let currentConfig = await loadStoredMasterConfig(root);
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
      runPlanner(root, currentConfig, input, {
        flow: async () => null,
        select: async () => ({
          account: { name: 'planner-acct', kind: 'claude', environment: {} } as any,
          health: null,
          skipped: [],
          release: async () => true,
        }),
        headless: async () => {
          launches += 1;
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

  // 1. Default (on): master status shows planner on, and planner launches on low-water board.
  const statusOn = await readStatus(currentConfig);
  assert.deepEqual((statusOn as any).planner, { on: true }, 'master status shows planner on by default');
  await runCycle(currentConfig, state, effects, () => now);
  assert.equal(launches, 1, 'planner launches when on (default)');
  assert.equal(createdPayloads.length, 1, 'draft filed when on');

  // 2. Turn planner off via master config planner=off (with operator-agent identity).
  await runConfig(['planner=off'], currentConfig);
  currentConfig = await loadStoredMasterConfig(root);
  const statusOff = await readStatus(currentConfig);
  assert.equal((statusOff as any).planner?.on, false, 'master status shows planner as off');
  assert.equal((statusOff as any).planner?.by, 'lead-operator', 'master status names who turned the planner off');
  assert.ok(typeof (statusOff as any).planner?.at === 'string', 'master status records when planner was turned off');

  // Advance past the 2-hour cooldown and test both low-water and 30m+ empty-board states.
  now += 130 * minute;
  work = [];
  state.actions[stallAlarmKey] = {
    kind: 'attention',
    work: null,
    principal: null,
    state: 'failed',
    detail: 'Stall: empty board',
    attempts: 1,
    epoch: null,
    cycle: 2,
    at: new Date(now - 45 * minute).toISOString(),
    since: new Date(now - 45 * minute).toISOString(),
  };
  await runCycle(currentConfig, state, effects, () => now);
  assert.equal(launches, 1, 'no planner launch on empty board when planner=off');

  now += 15 * minute;
  work = [makeWork('GY-502')];
  await runCycle(currentConfig, state, effects, () => now);
  assert.equal(launches, 1, 'no planner launch on low-water board when planner=off');
  assert.equal(createdPayloads.length, 1, 'no drafts filed while planner=off');

  // 3. Turn planner back on via planner=on: status shows on and planner launches again.
  await runConfig(['planner=on'], currentConfig);
  currentConfig = await loadStoredMasterConfig(root);
  const statusRestored = await readStatus(currentConfig);
  assert.deepEqual((statusRestored as any).planner, { on: true }, 'planner=on restores planner in master status');
  await runCycle(currentConfig, state, effects, () => now);
  assert.equal(launches, 2, 'planner launches again after planner=on');
  assert.equal(createdPayloads.length, 2, 'draft filed again after planner=on');

  // 4. Turn off again and restore via empty value (planner=).
  await runConfig(['planner=off'], currentConfig);
  currentConfig = await loadStoredMasterConfig(root);
  assert.equal((await readStatus(currentConfig) as any).planner?.on, false);
  await runConfig(['planner='], currentConfig);
  currentConfig = await loadStoredMasterConfig(root);
  assert.deepEqual((await readStatus(currentConfig) as any).planner, { on: true }, 'planner= also restores planner to on');
});
