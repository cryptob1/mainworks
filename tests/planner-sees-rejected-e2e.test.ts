import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import type { PlannerInput } from '../src/daemon/planner.js';
import { runPlanner } from '../src/master/planner.js';
import type { WorkerProfile } from '../src/master/profiles.js';
import { adminToken, coordinatorToken, pipelineWorld } from './helpers/pipeline-world.js';

// GY-3911: on a running test install the planner prompt contains a recently closed draft and its reason.
test('e2e:planner-sees-rejected — on a running test install the planner prompt contains a recently closed draft and its reason', { timeout: 120_000 }, async () => {
  const world = await pipelineWorld('planner-sees-rejected');
  try {
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
        reason: 'Provision the master operator-agent identity for the planner-sees-rejected e2e test',
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

    // File a planner-origin draft and close it with a reason, just like the Lead does.
    const draftTitle = 'Split merge-writer trial cache by shard';
    const closeReason = 'Not needed; cache hit rate is already above 95%';
    const created = await masterApi('work', {
      title: draftTitle,
      why: 'Faster trial cache lookups reduce merge latency.',
      simplest: 'Partition the cache directory by shard number.',
      type: 'chore',
      priority: 2,
      criteria: [],
      origin: 'planner',
      reason: 'Empty-board planner draft.',
    });
    assert.ok(created?.id && created?.key, 'planner draft was created');

    const closed = await masterApi(`work/${encodeURIComponent(created.id)}/close`, {
      kind: 'obsolete',
      reason: closeReason,
    });
    assert.equal(closed.stage, 'done', 'closed draft moved to done');
    assert.equal(closed.closure?.reason, closeReason, 'closed draft recorded its reason');

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
      detail: `Stall: 4 free builder slot(s) and no ready, released or releasable work since ${new Date(now - 50 * 60_000).toISOString()}.`,
      attempts: 1,
      epoch: null,
      cycle: 1,
      at: new Date(now - 31 * 60_000).toISOString(),
      since: new Date(now - 31 * 60_000).toISOString(),
    };

    const prompts: string[] = [];
    await runCycle(
      config,
      state,
      {
        // Simulate the live loop's open-only coordination snapshot so runPlanner fetches closed drafts from /api/work-snapshot.
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
    assert.match(prompt, /closed in the last (?:7|seven) days/i, 'planner prompt lists closed drafts under their own heading');
    assert.ok(prompt.includes(`${created.key}: ${draftTitle}`), 'planner prompt contains the recently closed draft key and title');
    assert.ok(prompt.includes(closeReason), 'planner prompt contains the close reason');
  } finally {
    await world.close();
  }
});
