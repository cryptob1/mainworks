import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { stallAlarmKey } from '../src/daemon/stall-alarm.js';
import { fleetCommand } from '../src/cli/master/fleet.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { runPlanner } from '../src/master/planner.js';
import { loadStoredMasterConfig } from '../src/master/config.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master/profiles.js';
import { adminToken, coordinatorToken, pipelineWorld } from './helpers/pipeline-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3890: on a running test install with planner=off and an empty board for an hour,
// no planner draft is filed and master status shows the planner as off with who set it.
test('e2e:planner-switch — running test install with planner=off and an empty board for an hour files no planner draft', { timeout: 120_000 }, async () => {
  const world = await pipelineWorld('planner-switch');
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

    const operatorAgentToken = `planner-switch-operator-${'z'.repeat(32)}`;
    const provisioned = await fetch(`${world.url}/api/operator-agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'e2e-planner-switch-operator' },
      body: JSON.stringify({
        id: 'master-operator-agent',
        displayName: 'Master Operator Agent',
        capabilities: [],
        scope: { repositories: [world.config.repository], workItems: ['*'] },
        token: operatorAgentToken,
        reason: 'Provision the master operator-agent identity for the planner-switch e2e test',
      }),
    });
    assert.ok(provisioned.ok, `provision operator-agent (${provisioned.status}): ${await provisioned.text()}`);

    const credentialsDir = await temporaryDirectory('planner-switch-creds');
    const operatorCredentialFile = join(credentialsDir, 'operator-agent.token');
    writeFileSync(operatorCredentialFile, operatorAgentToken);
    chmodSync(operatorCredentialFile, 0o600);
    const coordinatorCredentialFile = join(credentialsDir, 'coordinator.token');
    writeFileSync(coordinatorCredentialFile, coordinatorToken);
    chmodSync(coordinatorCredentialFile, 0o600);

    const installRoot = await temporaryDirectory('planner-switch-install');
    execFileSync('git', ['init', '-q', '-b', 'main', installRoot]);
    mkdirSync(join(installRoot, '.graphyard'), { recursive: true });
    const baseConfig = masterConfigSchema.parse({
      ...world.config,
      credentialFile: coordinatorCredentialFile,
      cliPath: resolve('bin/graphyard.mjs'),
      workers,
      operatorAgent: { id: 'master-operator-agent', credentialFile: operatorCredentialFile },
    });
    const masterConfigPath = join(installRoot, '.graphyard', 'master.json');
    writeFileSync(masterConfigPath, JSON.stringify(baseConfig, null, 2));
    chmodSync(masterConfigPath, 0o600);

    // Turn planner off through master config with the operator-agent identity.
    await fleetCommand({
      id: 'config',
      args: ['planner=off'],
      root: installRoot,
      master: baseConfig,
      print: (value: unknown) => value,
      coordinator: { actor: { id: 'graphyard-master-app' } },
    } as never);
    const config = await loadStoredMasterConfig(installRoot);

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

    const startTime = Date.now();
    let now = startTime;
    const state = emptyDaemonState(config);
    state.lock = {
      id: 'lock',
      pid: process.pid,
      host: config.hostId,
      startedAt: new Date(startTime - 60 * 60_000).toISOString(),
      heartbeatAt: new Date(startTime).toISOString(),
    };
    state.projectMemory.brief = {
      markdown: '## Problem\nKeep the line fed overnight.',
      updatedAt: new Date(startTime).toISOString(),
      by: 'lead',
      why: 'seed',
      history: [],
    };
    // Empty-board alarm held for an hour.
    state.actions[stallAlarmKey] = {
      kind: 'attention',
      work: null,
      principal: null,
      state: 'failed',
      detail: `Stall: 4 free builder slot(s) and no ready, released or releasable work since ${new Date(startTime - 60 * 60_000).toISOString()}.`,
      attempts: 1,
      epoch: null,
      cycle: 1,
      at: new Date(startTime - 60 * 60_000).toISOString(),
      since: new Date(startTime - 60 * 60_000).toISOString(),
    };

    let plannerInvocations = 0;
    const plannerOutput = JSON.stringify([
      { title: 'Unwanted draft', why: 'Should never be filed when planner=off.', simplest: 'Not filed.' },
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
      planner: (input: { brief: string | null; openTitles: string[] }) => {
        plannerInvocations += 1;
        return runPlanner(process.cwd(), config, input, {
          flow: async () => masterApi('flow'),
          select: async () => ({
            account: { name: 'planner-acct', kind: 'claude', environment: {} } as any,
            health: null,
            skipped: [],
            release: async () => true,
          }),
          headless: async () => plannerOutput,
          createWork: payload => masterApi('work', payload),
        });
      },
    } as unknown as DaemonEffects;

    // Run cycles across a full hour with an empty board.
    for (let elapsedMinutes = 0; elapsedMinutes <= 60; elapsedMinutes += 15) {
      now = startTime + elapsedMinutes * 60_000;
      await runCycle(config, state, effects, () => now);
    }

    const snapshot = await masterApi('work-snapshot');
    assert.equal(plannerInvocations, 0, 'planner never launched while planner=off');
    assert.equal(snapshot.work.length, 0, 'no planner draft was filed during an hour on an empty board');

    const report = await masterStatusReport(
      installRoot,
      config,
      path => masterApi(path),
      async (command, args) =>
        isHerdrCommand(command)
          ? herdrSubcommand(args)[1] === 'list'
            ? JSON.stringify({ agents: [] })
            : ''
          : `${world.base}\n`,
    );
    assert.equal((report as any).planner?.on, false, 'master status shows planner as off');
    assert.equal((report as any).planner?.by, 'master-operator-agent', 'master status names who set planner=off');
  } finally {
    await world.close();
  }
});
