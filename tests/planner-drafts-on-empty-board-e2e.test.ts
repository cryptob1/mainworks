import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { runPlanner } from '../src/master/planner.js';
import type { WorkerProfile } from '../src/master/profiles.js';
import { adminToken, coordinatorToken, pipelineWorld } from './helpers/pipeline-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3835: on a running test install an empty board for 30 minutes yields at most three unreleased
// draft items listed in master status.
test('e2e:planner-drafts-on-empty-board — running test install with an empty board for 30 minutes yields at most three unreleased draft items listed in master status', { timeout: 120_000 }, async () => {
  const world = await pipelineWorld('planner-drafts-on-empty-board');
  try {
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
    const config = { ...world.config, credentialFile: join(world.root, 'coordinator.token'), workers };

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
      markdown: '## Problem\nKeep the line fed overnight.\n## What success looks like\n4 to 6 merged changes an hour.',
      updatedAt: new Date(now).toISOString(),
      by: 'lead',
      why: 'seed',
      history: [],
    };
    // Alarm already held for 31 minutes on this empty board.
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
        reason: 'Provision the master operator-agent identity for the empty-board planner e2e test',
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

    const plannerOutput = JSON.stringify([
      { title: 'Trim slowest trial test', why: 'Cuts merge trial wait time.', simplest: 'Cache the test fixture once per file.' },
      { title: 'Auto-sync stale branch', why: 'Cuts base-moved rework rounds.', simplest: 'Rebase onto main before submitting.' },
      { title: 'Surface idle slot count', why: 'Shows the owner when capacity sits idle.', simplest: 'Add the count to the header.' },
      { title: 'Extra fourth draft', why: 'Should be capped out.', simplest: 'Dropped by cap of three.' },
    ]);

    await runCycle(
      config,
      state,
      {
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
        planner: (input: { brief: string | null; openTitles: string[] }) =>
          runPlanner(process.cwd(), config, input, {
            flow: async () => masterApi('flow'),
            select: async () => ({
              account: { name: 'planner-acct', kind: 'claude', environment: {} } as any,
              health: null,
              skipped: [],
              release: async () => true,
            }),
            headless: async () => plannerOutput,
            createWork: payload => masterApi('work', payload),
          }),
      } as unknown as DaemonEffects,
      () => now,
    );

    await writeFile(daemonStatePath(config), JSON.stringify(state));
    const snapshot = await masterApi('work-snapshot');
    assert.equal(snapshot.work.length, 3, 'at most three unreleased draft items were created');
    for (const item of snapshot.work) {
      assert.equal(item.ready, false, `${item.key} is unreleased`);
      assert.equal(item.criteria.length, 1, `${item.key} has one initial criterion`);
      assert.deepEqual(item.criteria[0]!.proofs, [], `${item.key} awaits Lead proofs`);
      assert.ok(item.why && item.simplest, `${item.key} has why and simplest`);
    }

    const root = await temporaryDirectory('planner-drafts-e2e-status');
    execFileSync('git', ['init', '-q', root]);
    const report = await masterStatusReport(
      root,
      config,
      path => masterApi(path),
      async (command, args) =>
        isHerdrCommand(command)
          ? herdrSubcommand(args)[1] === 'list'
            ? JSON.stringify({ agents: [] })
            : ''
          : `${world.base}\n`,
    );

    for (const item of snapshot.work) {
      assert.ok(
        report.attention.some(entry => entry.subject === item.key || entry.text.includes(item.key)),
        `master status lists planner draft ${item.key} under attention`,
      );
    }
  } finally {
    await world.close();
  }
});
