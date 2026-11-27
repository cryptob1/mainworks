import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { deployOnce, readDeployRecord } from '../src/deploy-watch.js';
import { deployPorts } from './helpers/deploy-ports.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40);

/** A control plane already serving `serving`; the deploy record (if any) still names the older commit a. */
function plane(serving: string) {
  const state = { serving, builds: [] as string[], restarts: [] as string[] };
  const ports = deployPorts(b, a, {
    build: async commit => { state.builds.push(commit); if (commit === b) throw new Error('io: read/write on closed pipe'); },
    restart: async commit => { state.restarts.push(commit); state.serving = commit; },
    health: async commit => { if (state.serving !== commit) throw new Error(`/healthz answers ${state.serving.slice(0, 7)}`); },
    serves: async commit => state.serving === commit,
  });
  return { state, ports };
}

test('integration:watch-skips-serving-commit — a watch started after a handover, whose verified commit already serves healthy, builds, restarts and rolls back nothing; a newer commit deploys as today', async () => {
  // AC-1: the handed-over watch finds b already serving, though its record still names a.
  {
    const directory = await temporaryDirectory('watch-skips-serving-commit');
    const file = join(directory, '.graphyard', 'deploy.json');
    const { state, ports } = plane(b);
    assert.equal(await deployOnce(file, ports, () => {}), 'unchanged');
    assert.deepEqual(state.builds, [], 'no second build of the serving commit');
    assert.deepEqual(state.restarts, [], 'no restart or rollback');
    assert.equal(state.serving, b, 'the verified commit stays served');
    assert.equal(readDeployRecord(file)?.tip, b, 'recorded as serving');
    assert.equal(readDeployRecord(file)?.failed, null);
  }
  // A commit newer than the serving one deploys as today.
  {
    const directory = await temporaryDirectory('watch-skips-serving-commit');
    const file = join(directory, '.graphyard', 'deploy.json');
    const { state, ports } = plane(a);
    ports.build = async commit => { state.builds.push(commit); };
    assert.equal(await deployOnce(file, ports, () => {}), 'deployed');
    assert.deepEqual(state.builds, [b]);
    assert.deepEqual(state.restarts, [b]);
    assert.equal(readDeployRecord(file)?.tip, b);
  }
});
