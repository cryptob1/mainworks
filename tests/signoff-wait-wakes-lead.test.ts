import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { mergeWriterIdle } from '../src/daemon/cycle-merge-writer.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { coordinatorToken, cycleUntil, loopReads, pipelineWorld, rollout } from './helpers/pipeline-world.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3770: an item whose passed trial leaves only a Lead-attestable manual proof open wakes the Lead's
// session, records the wake on the daemon cursor, appears first in master status attention, and shows up
// under 'waiting for sign-off' in /api/flow.
test('e2e:signoff-wait-wakes-lead — passed trial with one manual proof open records a wake to the Lead and reports waiting for sign-off in flow', { timeout: 600_000 }, async () => {
  const world = await pipelineWorld('signoff-wait-wakes-lead');
  try {
    await rollout(world);
    const proof = 'manual:lead-signoff';
    const item = await world.submit('Change awaiting sign-off', { 'note.txt': 'ready for sign-off\n' }, { proofs: [proof] });
    const head = item.candidate!.sha;
    const current = async () => (await world.work()).find(entry => entry.key === item.key)!;

    const state = emptyDaemonState(world.config);
    const prompts: string[] = [];
    const lines: string[] = [];
    let lastSnapshot = await world.work();
    const loop = {
      state,
      lines,
      get lastSnapshot() { return lastSnapshot; },
      gating: () => {},
      cycle: () => runCycle(world.config, state, {
        agents: () => [{ name: world.config.masterAgentName, pane_id: 'pLead', agent_status: 'idle' }],
        herdr: () => ({ agents: [{ name: world.config.masterAgentName, pane_id: 'pLead', agent_status: 'idle' }], available: true }),
        credentials: async () => ({}),
        snapshot: async () => ({ work: lastSnapshot = await world.work(), now: new Date().toISOString() }),
        closeSession: () => {},
        dispatch: async () => {},
        persist: async () => {},
        mergeWriter: loopReads({ ...world, snapshot: world.work }, { gate: false }),
        rework: async () => {},
        masterSession: {
          wake: async (target: string, text: string) => {
            assert.equal(target, 'pLead');
            prompts.push(text);
          },
          launch: async () => ({ agentName: world.config.masterAgentName, pane: 'pLead', runtime: 'codex', account: 'account', session: 'lead-session' }),
        },
      } as unknown as DaemonEffects, Date.now, undefined, line => { lines.push(line); }),
    };

    await cycleUntil(loop, 'the trial passes ahead of acceptance', async () => {
      const ledger = (await current()).mergeLedger;
      return ledger?.state === 'refused' && ledger.trial?.head === head;
    }, 200_000);
    await mergeWriterIdle(state);

    // Run one more cycle now that the trial passed and acceptance only awaits the manual proof.
    await loop.cycle();

    assert.equal(prompts.length, 1, 'Lead session received one wake');
    assert.ok(prompts[0].includes(item.key), 'wake names the item key');
    assert.ok(prompts[0].includes(proof), 'wake names the manual proof');
    assert.ok(prompts[0].includes(head.slice(0, 12)), 'wake names the candidate head');
    assert.equal(state.actions['master:wake']?.kind, 'wake');
    assert.equal(state.actions['master:wake']?.state, 'done');
    assert.ok(state.actions['master:wake']?.detail.includes(item.key));
    assert.ok(state.master.lastWake && !state.master.lastWake.heartbeat);

    // Flow numbers report the acceptance wait split into 'waiting for sign-off' and 'waiting for the merge writer'.
    const masterApi = async (path: string) => {
      const response = await fetch(`${world.url}/api/${path}`, { headers: { Authorization: `Bearer ${coordinatorToken}` } });
      const text = await response.text();
      if (!response.ok) throw Object.assign(new Error(text), { status: response.status });
      return JSON.parse(text);
    };
    const flow = await masterApi('flow');
    const day = flow['24h'];
    assert.ok('waiting for sign-off' in day.stations, 'flow stations include waiting for sign-off');
    assert.ok('waiting for the merge writer' in day.stations, 'flow stations include waiting for the merge writer');
    assert.equal(day.stations['waiting for sign-off']?.oldest.key, item.key);
    assert.equal(day.stations['waiting for sign-off']?.oldest.waiting, true);

    // Master status lists the sign-off wait at the top of attention.
    const root = await temporaryDirectory('signoff-wait-status-root');
    execFileSync('git', ['init', '-q', root]);
    const report = await masterStatusReport(
      root,
      world.config,
      masterApi,
      async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${world.base}\n`,
    );
    assert.equal(report.attention[0]?.subject, item.key);
    assert.match(report.attention[0]?.text ?? '', new RegExp(`^waits for your sign-off: ${proof} on ${head.slice(0, 12)}, \\d+ min$`));
  } finally {
    await world.close();
  }
});
