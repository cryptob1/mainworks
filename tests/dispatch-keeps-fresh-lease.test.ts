import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { save } from '../src/store.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { earlyExitKey, failureHeld } from '../src/daemon/repeated-failure.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { coordinationSnapshot } from '../src/server/work-view.js';
import { masterConfigSchema } from '../src/master.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// What happened to GY-3498, GY-3502, GY-3542 and GY-3581 on 21 November 2026: one dispatch started
// the worker on an account that exited at once, its supervisor released the epoch, and the same
// dispatch started the next account under the next epoch. The loop's snapshot keeps only the newest
// attempt's end, so the close step read each earlier epoch as a lease loss; two of them stop dispatch.
test('integration:dispatch-keeps-fresh-lease, e2e:dispatch-keeps-fresh-lease — a released item builds on its running worker with no lease-loss session', { timeout: 120_000 }, async () => {
  const store = await withDatabase('dispatch-keeps-fresh-lease');
  await store.init();
  try {
    const engine = new Engine(store, 120, 'owner/project');
    const operator = { id: 'operator', role: 'admin', sessionKind: 'human' } as const;
    const coordinator = { id: 'loop', role: 'coordinator', sessionKind: 'ai' } as const;
    const worker = { id: 'worker-a', role: 'worker', sessionKind: 'ai' } as const;
    const id = () => randomUUID();
    let item = await engine.execute(operator, 'create', null, { title: 'Fresh lease', type: 'chore', criteria: [{ id: 'AC-1', text: 'Keep the lease', proofs: ['e2e:dispatch-keeps-fresh-lease'] }] }, id());
    item = await engine.execute(operator, 'ready', item.id, {}, id());
    const session = (epoch: number, rest: Record<string, unknown>) => engine.execute(coordinator, 'session', item.id,
      { id: `${worker.id}:${epoch}`, kind: 'implementation', principal: worker.id, runtime: 'claude', host: 'fresh-host', subject: 'Fresh lease', ...rest }, id());
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/unused/token', cliPath: '/unused/cli', repository: 'owner/project', baseBranch: 'main', hostId: 'fresh-host', masterAgentName: 'master', workers: [] });
    const state = emptyDaemonState(config), removed: string[] = [];
    let dispatched = 0;
    const effects: DaemonEffects = {
      // The loop reads the coordination view, which drops the attempt timeline.
      snapshot: async () => coordinationSnapshot({ work: await store.list(), now: new Date().toISOString() }),
      agents: () => [], credentials: async () => ({}), dispatch: async () => { dispatched++; }, persist: async () => {},
      closeSession: async () => {}, sessionScreen: () => 'No API key found for zai.',
      removeWorktree: async path => { removed.push(path); return true; },
      recordSession: async (work, handle) => { await engine.execute(coordinator, 'session', work.id, handle, id()); },
    };
    // Two dispatch cycles of one launch, before any supervisor heartbeat: each claims, starts a run
    // that exits at once, and is recorded by its launcher as it starts and as it ends.
    const running = 2;
    for (let epoch = 1; epoch <= running; epoch++) {
      item = await engine.execute(worker, 'claim', item.id, {}, id());
      assert.equal(item.lease?.epoch, epoch);
      await session(epoch, { state: 'running' });
      if (epoch === running) break;
      // Just dispatched, no supervisor heartbeat yet: the worker runs on epoch 1 and the loop leaves it alone.
      const fresh = await runCycle(config, state, effects, Date.now, undefined, () => {});
      assert.deepEqual(fresh.actions.filter(action => action.kind === 'close' || action.kind === 'reclaim'), []);
      const dispatchedOnce = (await store.list())[0];
      assert.equal(dispatchedOnce.stage, 'build');
      assert.equal(dispatchedOnce.lease?.epoch, 1);
      assert.equal(dispatchedOnce.sessions!.find(handle => handle.id === `${worker.id}:1`)?.state, 'running');
      item = await engine.execute(worker, 'release', item.id, { epoch, cause: `Watch supervisor ended attempt ${epoch}: the agent process exited (code 1) while its lease was live` }, id());
      await session(epoch, { state: 'finished', outcome: 'the pi worker exited at once: No API key found for zai.' });
    }
    item = (await store.list())[0];
    item.workspaces = [1, 2].map(epoch => ({ host: 'fresh-host', path: `/worktrees/fresh-${epoch}`, epoch, owner: worker.id, branch: `graphyard/fresh-${epoch}` }));
    await store.transaction((db, now) => save(db, item, operator.id, 'fixture', now));
    const first = await runCycle(config, state, effects, Date.now, undefined, () => {});
    await new Promise(resolve => setTimeout(resolve, 200));
    const stored = (await store.list())[0];
    const lost = /lease loss/;
    assert.deepEqual(first.actions.filter(action => lost.test(action.detail)).map(action => action.detail), [], 'no session is closed as a lease loss');
    assert.equal(state.actions[earlyExitKey(stored)], undefined, 'no lease-loss incident is recorded for epoch 1');
    assert.equal(failureHeld(state.failureRuns[stored.id]), false, 'dispatch of the item is not stopped');
    assert.deepEqual(stored.sessions!.filter(handle => lost.test(handle.outcome ?? '')).map(handle => handle.id), [], 'no lease-loss session in the history');
    assert.equal(stored.stage, 'build');
    assert.equal(stored.lease?.epoch, running, 'the running epoch keeps its lease');
    assert.equal(stored.sessions!.find(handle => handle.id === `${worker.id}:${running}`)?.state, 'running', 'its worker session stays open');
    assert.ok(!removed.includes(`/worktrees/fresh-${running}`), 'its worktree stays');
    assert.equal(dispatched, 0, 'no further epoch is dispatched');

    // A worker whose supervisor never starts renews nothing: once its lease is gone the session is ended as today.
    await engine.execute(worker, 'release', item.id, { epoch: running }, id());
    const second = await runCycle(config, state, effects, Date.now, undefined, () => {});
    assert.ok(second.actions.some(action => action.kind === 'close' && action.state === 'done' && action.detail.includes(`${worker.id}:${running}`)), 'the leaseless session is closed');
    assert.equal((await store.list())[0].sessions!.find(handle => handle.id === `${worker.id}:${running}`)?.state, 'finished');
  } finally { await store.close(); }
});
