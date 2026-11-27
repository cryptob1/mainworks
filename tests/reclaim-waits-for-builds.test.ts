import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { diskHeadroomStep, reclaimJobLeftovers, reclaimMainworksLeftovers } from '../src/daemon/disk-headroom.js';
import { emptyDaemonState, type DaemonAction } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { acquireVerificationSlot } from '../src/master/verification-slots.js';
import type { ChildRun } from '../src/child-runner.js';

const GB = 1e9;
const config = masterConfigSchema.parse({ version: 1, url: 'http://localhost:1', credentialFile: '/token', cliPath: '/cli', repository: 'owner/repo', baseBranch: 'main', hostId: 'core', masterAgentName: 'master', workers: [] });

/** Docker with one stale owned image and old trial build cache; every removal or prune is logged. */
function fakeDocker(onRemove: () => Promise<void> = async () => {}) {
  const pruned: string[] = [];
  const run: ChildRun = async (_command, args) => {
    if (args[0] === 'images') return args[1] === 'graphyard-trial' ? 'graphyard-trial:stale' : '';
    if (args[0] === 'image' && args[1] === 'rm') { pruned.push(args.join(' ')); await onRemove(); return ''; }
    if (args[0] === 'buildx' && args[1] === 'prune') { pruned.push(args.join(' ')); return 'Total: 8GB'; }
    return '';
  };
  return { run, pruned };
}

test('integration:reclaim-waits-for-builds — a reclaim pass while a build holds a heavy-job slot skips and says so; a build started during a reclaim waits for it', async () => {
  const slots = await temporaryDirectory('reclaim-slots'), warmInUse = await temporaryDirectory('reclaim-warm');
  const build = await acquireVerificationSlot({ directory: slots, label: 'deploy build abc123' });
  const docker = fakeDocker();
  const state = emptyDaemonState(config);
  const performed: DaemonAction[] = [];
  await diskHeadroomStep({ config, state, performed, now: () => Date.parse('2026-11-27T12:00:00Z'), effects: {
    snapshot: async () => ({ work: [], now: new Date().toISOString() }), agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {},
    diskVolumes: async () => [{ path: '/docker', freeBytes: 50 * GB, totalBytes: 1000 * GB, docker: true }],
    reclaimDisk: () => reclaimMainworksLeftovers(docker.run, { temporary: [], checkouts: [], verification: [], warmInUse, slots }),
  } });
  const sweep = await reclaimJobLeftovers(docker.run, { temporary: [], checkouts: [], verification: [], warmInUse, slots });
  assert.deepEqual(docker.pruned, [], 'no image or build cache is removed while a build holds a slot');
  assert.match(sweep.skipped ?? '', /deploy build abc123/);
  const skip = Object.values(state.actions).find(action => /skipped/i.test(action.detail));
  assert.match(skip?.detail ?? '', /image and build-cache reclaim skipped: deploy build abc123 holds a heavy-job slot/i, 'status says the pass skipped and who holds the slot');
  build.release();

  // With no slot held the reclaim runs, holding a slot: a build that starts meanwhile waits until it ends.
  let releaseRemoval!: () => void, removing!: () => void;
  const removalStarted = new Promise<void>(started => { removing = started; });
  const removalHeld = new Promise<void>(done => { releaseRemoval = done; });
  const blocking = fakeDocker(async () => { removing(); await removalHeld; });
  const reclaim = reclaimMainworksLeftovers(blocking.run, { temporary: [], checkouts: [], verification: [], warmInUse, slots });
  await removalStarted;
  let started = false;
  const next = acquireVerificationSlot({ directory: slots, label: 'deploy build def456', pollMs: 20 }).then(held => { started = true; return held; });
  await new Promise(done => setTimeout(done, 300));
  assert.equal(started, false, 'a build started during the reclaim waits for it');
  releaseRemoval();
  assert.deepEqual([...await reclaim], ['trial build cache older than a day (8GB)', 'image graphyard-trial:stale']);
  (await next).release();
  assert.equal(started, true);
});
