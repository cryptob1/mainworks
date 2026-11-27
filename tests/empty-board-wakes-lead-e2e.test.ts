import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, daemonStatePath, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import type { WorkerProfile } from '../src/master/profiles.js';
import { coordinatorToken, pipelineWorld } from './helpers/pipeline-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3778: on a running test install with no open items and free builder slots, master status shows
// the empty-board alarm and the loop wakes the Lead.
test('e2e:empty-board-wakes-lead — running test install with no open items and free builder slots shows the empty-board alarm in master status', { timeout: 120_000 }, async () => {
  const world = await pipelineWorld('empty-board-wakes-lead');
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
      startedAt: new Date(now - 16 * 60_000).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
    };

    const masterApi = async (path: string) => {
      const response = await fetch(`${world.url}/api/${path}`, {
        headers: { Authorization: `Bearer ${coordinatorToken}` },
      });
      const text = await response.text();
      if (!response.ok) throw Object.assign(new Error(text), { status: response.status });
      return JSON.parse(text);
    };

    const wakes: string[] = [];
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
          wake: async (_target: string, text: string) => {
            wakes.push(text);
          },
          launch: async () => ({
            agentName: config.masterAgentName,
            pane: 'pLead',
            runtime: 'codex',
            account: 'account',
            session: 'lead-session',
          }),
        },
      } as unknown as DaemonEffects,
      () => now,
    );

    await writeFile(daemonStatePath(config), JSON.stringify(state));
    const root = await temporaryDirectory('empty-board-e2e-status');
    execFileSync('git', ['init', '-q', root]);
    const report = await masterStatusReport(
      root,
      config,
      masterApi,
      async (command, args) =>
        isHerdrCommand(command)
          ? herdrSubcommand(args)[1] === 'list'
            ? JSON.stringify({ agents: [] })
            : ''
          : `${world.base}\n`,
    );

    assert.equal(Object.keys(report)[0], 'stallAlarm', 'stallAlarm heads master status');
    assert.ok(report.stallAlarm, 'master status shows the empty-board alarm');
    assert.match(report.stallAlarm, /no work/i, 'alarm says the line has no work');
    assert.match(report.stallAlarm, /4 free builder slot/i, 'alarm names the free builder slots');
    assert.equal(wakes.length, 1, 'Lead session was woken once');
    assert.match(wakes[0], /board is empty/i);
  } finally {
    await world.close();
  }
});
