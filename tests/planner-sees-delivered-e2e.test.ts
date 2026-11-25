import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import type { PlannerInput } from '../src/daemon/planner.js';
import { runPlanner } from '../src/master/planner.js';
import { recordTestSelection } from '../src/merge-writer/test-selection.js';
import type { WorkerProfile } from '../src/master.js';
import { adminToken, coordinatorToken, cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';

// GY-3845: on a running test install the planner prompt contains a recently delivered item's title
// and labels testSelection shares as of reachable and of all tests.
test('e2e:planner-sees-delivered — on a running test install the planner prompt contains a recently delivered item title', { timeout: 120_000 }, async () => {
  const world = await pipelineWorld('planner-sees-delivered');
  try {
    // Deliver one real item through the running test install.
    const deliveredTitle = 'Record per-file trial test timings';
    const submitted = await world.submit(deliveredTitle, { 'site/note.txt': 'delivered\n' });
    const mergeLoop = worldLoop(world, { gate: false });
    await cycleUntil(mergeLoop, `${submitted.key} delivered`, async () => (await world.work()).find(item => item.id === submitted.id)?.stage === 'done');
    const afterMerge = (await world.work()).find(item => item.id === submitted.id)!;
    assert.equal(afterMerge.stage, 'done', 'submitted item was delivered on the running test install');
    assert.ok(afterMerge.delivery?.mergedAt, 'delivered item records mergedAt');

    // Write the coordinator credential file so runPlanner can read /api/work-snapshot like production.
    const credentialFile = join(world.root, 'coordinator.token');
    await writeFile(credentialFile, coordinatorToken, { mode: 0o600 });

    // Record a trial selection on the install checkout so testSelection is populated.
    await mkdir(join(world.root, '.graphyard'), { recursive: true });
    await recordTestSelection(world.root, { selected: 6, reachable: 8, all: 12, key: submitted.key, files: ['proof.cjs'] });

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
    const config = { ...world.config, credentialFile, workers };

    const now = Date.now();
    const state = emptyDaemonState(config);
    state.lock = {
      id: 'lock',
      pid: process.pid,
      host: config.hostId,
      startedAt: new Date(now - 50 * 60_000).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
    };
    state.projectMemory.brief = {
      markdown: '## Problem\nKeep the line fed overnight.',
      updatedAt: new Date(now).toISOString(),
      by: 'lead',
      why: 'seed',
      history: [],
    };
    state.actions[stallAlarmKey] = {
      kind: 'attention',
      work: null,
      principal: null,
      state: 'failed',
      detail: `Stall: 4 free builder slot(s) and no ready, released or releasable work since ${new Date(now - 50 * 60_000).toISOString()}. Cause: the line has no work to build (4 free builder slot(s)).`,
      attempts: 1,
      epoch: null,
      cycle: 1,
      at: new Date(now - 31 * 60_000).toISOString(),
      since: new Date(now - 31 * 60_000).toISOString(),
    };

    const operatorAgentToken = `planner-operator-agent-${'z'.repeat(32)}`;
    const provisioned = await fetch(`${world.url}/api/operator-agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'e2e-provision-operator-agent' },
      body: JSON.stringify({
        id: 'master-operator-agent',
        displayName: 'Master Operator Agent',
        capabilities: [],
        scope: { repositories: [config.repository], workItems: ['*'] },
        token: operatorAgentToken,
        reason: 'Provision the master operator-agent identity for the planner-sees-delivered e2e test',
      }),
    });
    assert.ok(provisioned.ok, `provision operator-agent (${provisioned.status}): ${await provisioned.text()}`);

    const masterApi = async (path: string, body?: unknown) => {
      const response = await fetch(`${world.url}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${body === undefined ? coordinatorToken : operatorAgentToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': `e2e-${Math.random()}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) throw Object.assign(new Error(text), { status: response.status });
      return JSON.parse(text);
    };

    const prompts: string[] = [];
    await runCycle(
      config,
      state,
      {
        // Simulate the live loop's open-only coordination snapshot so runPlanner fetches delivered items from /api/work-snapshot.
        snapshot: async () => ({ work: [], now: new Date(now).toISOString() }),
        agents: () => [{ name: config.masterAgentName, pane_id: 'pLead', agent_status: 'idle' }],
        herdr: () => ({ agents: [{ name: config.masterAgentName, pane_id: 'pLead', agent_status: 'idle' }], available: true }),
        credentials: async () => Object.fromEntries(workers.map(w => [w.name, { available: true, reason: null }])),
        closeSession: () => {},
        dispatch: async () => {},
        persist: async (next: DaemonState) => {
          await writeFile(daemonStatePath(config), JSON.stringify(next));
        },
        masterSession: {
          wake: async () => {},
          launch: async () => ({
            agentName: config.masterAgentName,
            pane: 'pLead',
            runtime: 'codex',
            account: 'account',
            session: 'lead-session',
          }),
        },
        planner: (input: PlannerInput) =>
          runPlanner(world.root, config, input, {
            flow: async () => masterApi('flow'),
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
            createWork: payload => masterApi('work', payload),
          }),
      } as unknown as DaemonEffects,
      () => now,
    );

    assert.equal(prompts.length, 1, 'planner session launched once');
    const prompt = prompts[0]!;
    assert.ok(prompt.includes(`${submitted.key}: ${deliveredTitle}`), 'planner prompt contains the recently delivered item key and title');
    assert.match(prompt, /delivered in the last (?:7|seven) days/i, 'planner prompt lists delivered items under their own heading');
    assert.match(prompt, /75%\s+of reachable/i, 'planner prompt labels selection share of reachable');
    assert.match(prompt, /50%\s+of all tests/i, 'planner prompt labels selection share of all tests');
  } finally {
    await world.close();
  }
});
