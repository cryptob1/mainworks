import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { deployOnce, readDeployRecord, type DeployWatchPorts } from '../src/deploy-watch.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40);

/** One control plane: one server, whose restart refuses while another restart is under way (as compose does). */
function plane(options: { restartFails?: (commit: string) => boolean } = {}) {
  const state = { serving: a, restarting: false, restarts: [] as string[] };
  const ports = (): DeployWatchPorts => ({
    fetch: async () => b,
    head: async () => a,
    build: async () => { await delay(30); },
    restart: async commit => {
      if (state.restarting) throw new Error('the container is already being recreated');
      state.restarting = true;
      state.restarts.push(commit);
      await delay(20);
      state.restarting = false;
      if (options.restartFails?.(commit)) throw new Error('compose up exited 1');
      state.serving = commit;
    },
    health: async commit => { if (state.serving !== commit) throw new Error(`/healthz answers ${state.serving.slice(0, 7)}`); },
    checkout: async () => {},
    pin: async () => {},
    prune: async () => {},
    schema: async () => 1,
    database: async () => 1,
  });
  return { state, ports };
}

test('integration:one-deploy-at-a-time — two watchers on one control plane and one commit: one builds and restarts, the other skips, the commit stays served; a restart that failed while the target already serves healthy does not roll back, a genuine failure still does', async () => {
  // AC-1: two watchers act on the same control plane and the same verified commit at once.
  {
    const directory = await temporaryDirectory('one-deploy-at-a-time');
    const file = join(directory, '.graphyard', 'deploy.json');
    const { state, ports } = plane();
    const outcomes = await Promise.all([deployOnce(file, ports(), () => {}), delay(5).then(() => deployOnce(file, ports(), () => {}))]);
    assert.equal(state.serving, b, 'the commit stays served');
    assert.deepEqual(state.restarts, [b], 'exactly one watcher restarts, and nobody restarts the previous commit');
    assert.deepEqual([...outcomes].sort(), ['deployed', 'unchanged'], 'one deploys, the other skips the round');
    assert.equal(readDeployRecord(file)?.tip, b);
    assert.equal(readDeployRecord(file)?.failed, null);
    // The next round finds the target already serving and does nothing.
    assert.equal(await deployOnce(file, ports(), () => {}), 'unchanged');
    assert.deepEqual(state.restarts, [b]);
  }
  // AC-2: this watcher's own restart failed, but the target commit already serves and is healthy.
  {
    const directory = await temporaryDirectory('one-deploy-at-a-time');
    const file = join(directory, '.graphyard', 'deploy.json');
    const { state, ports } = plane();
    const own = ports();
    own.restart = async () => { state.serving = b; throw new Error('the container is already being recreated'); };
    assert.equal(await deployOnce(file, own, () => {}), 'deployed');
    assert.equal(state.serving, b, 'no rollback: the target serves');
    assert.equal(readDeployRecord(file)?.tip, b);
  }
  // A genuine failed restart still rolls back as today.
  {
    const directory = await temporaryDirectory('one-deploy-at-a-time');
    const file = join(directory, '.graphyard', 'deploy.json');
    const { state, ports } = plane({ restartFails: commit => commit === b });
    assert.equal(await deployOnce(file, ports(), () => {}), 'rolled-back');
    assert.equal(state.serving, a);
    assert.deepEqual(state.restarts, [b, a]);
    assert.equal(readDeployRecord(file)?.tip, a);
    assert.equal(readDeployRecord(file)?.failed, b);
  }
});
