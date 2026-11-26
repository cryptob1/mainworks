import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { PlannerInput } from '../src/daemon/planner.js';
import { runPlanner } from '../src/master/planner.js';
import type { WorkerProfile } from '../src/master.js';
import type { Principal } from '../src/model.js';
import { adminToken, coordinatorToken, pipelineWorld } from './helpers/pipeline-world.js';

const operator: Principal = { id: 'operator', role: 'admin' };

// GY-3865: on a running test install with two ready items and free slots, a planner session launches once.
test('e2e:planner-low-water — running test install with two ready items and free slots launches one planner session', { timeout: 120_000 }, async () => {
  const world = await pipelineWorld('planner-low-water');
  try {
    // Seed two real ready items on the running test install.
    for (const title of ['Ready item one', 'Ready item two']) {
      const created = await world.engine.execute(
        operator,
        'create',
        null,
        { type: 'chore', title, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:declared', 'e2e:fixture'] }] },
        randomUUID(),
      );
      await world.engine.execute(operator, 'ready', created.id, {}, randomUUID());
    }

    const credentialFile = join(world.root, 'coordinator.token');
    await writeFile(credentialFile, coordinatorToken, { mode: 0o600 });

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
      startedAt: new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
    };
    state.projectMemory.brief = {
      markdown: '## Problem\nKeep Builders fed without 30-minute idle gaps.',
      updatedAt: new Date(now).toISOString(),
      by: 'lead',
      why: 'seed',
      history: [],
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
        reason: 'Provision the master operator-agent identity for the planner-low-water e2e test',
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

    let launches = 0;
    const plannerOutput = JSON.stringify([
      { title: 'Replenish queue item one', why: 'Keeps builders fed.', simplest: 'Smallest change one.' },
      { title: 'Replenish queue item two', why: 'Avoids idle gaps.', simplest: 'Smallest change two.' },
    ]);

    const effects = {
      snapshot: async () => masterApi('work-snapshot'),
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
          headless: async () => {
            launches += 1;
            return plannerOutput;
          },
          createWork: payload => masterApi('work', payload),
        }),
    } as unknown as DaemonEffects;

    // First cycle with two ready items and free slots: launches planner once.
    await runCycle(config, state, effects, () => now);
    // Second cycle within the 2-hour cooldown: must not launch a second time.
    await runCycle(config, state, effects, () => now + 60_000);

    assert.equal(launches, 1, 'planner session launched once');
    const snapshot = await masterApi('work-snapshot');
    const drafts = snapshot.work.filter((item: { origin?: string }) => item.origin === 'planner');
    assert.equal(drafts.length, 2, 'planner filed its unreleased drafts on the running test install');
    for (const draft of drafts) {
      assert.equal(draft.ready, false, `${draft.key} is unreleased`);
      assert.deepEqual(draft.criteria, [], `${draft.key} has no criteria`);
    }
  } finally {
    await world.close();
  }
});
