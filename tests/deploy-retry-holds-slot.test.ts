// GY-4047: a deploy holds its heavy-job slot from its first image build until it pins, so a reclaim
// pass between a failed build and its retry skips; the retry of a BuildKit lease error runs without cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlPlaneRecordPath, deployOnce, deployRecordPath, readControlPlaneRecord } from '../src/deploy-watch.js';
import { reclaimJobLeftovers, type Reclaimed } from '../src/daemon/disk-headroom.js';
import { slotsDirectoryVariable, withHeavyJob } from '../src/master/verification-slots.js';
import type { ChildRun } from '../src/child-runner.js';
import { deployPorts } from './helpers/deploy-ports.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const previous = 'a'.repeat(40), next = 'b'.repeat(40), blob = `sha256:1766afdf${'d'.repeat(56)}`;
// GY-4052: isolate the image lock from the host's real lock.
process.env.MAINWORKS_LOCK_ROOT = await temporaryDirectory('retry-slot-locks');

test('integration:deploy-retry-holds-slot — a reclaim pass during a lease-error retry skips while the deploy holds its slot, and the retry runs without cache', { timeout: 30_000 }, async () => {
  const [root, slots, warmInUse] = await Promise.all([temporaryDirectory('retry-slot'), temporaryDirectory('retry-slot-slots'), temporaryDirectory('retry-slot-warm')]);
  const pruned: string[] = [];
  const docker: ChildRun = async (_command, args) => {
    if (args[0] === 'images') return args[1] === 'graphyard-trial' ? 'graphyard-trial:warm' : '';
    if ((args[0] === 'image' && args[1] === 'rm') || args[0] === 'buildx') pruned.push(args.join(' '));
    return '';
  };
  const saved = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = slots;
  try {
    let reclaim = null as Promise<Reclaimed> | null, serving = previous;
    const builds: boolean[] = [];
    const ports = deployPorts(next, previous, {
      // The stand-in restart takes the deploy path's reserved slot, as the production port does.
      restart: (commit, options) => withHeavyJob(`deploy restart ${commit.slice(0, 12)}`, async () => {
        if (builds.length) await reclaim;
        builds.push(options?.noCache ?? false);
        if (builds.length === 1) throw new Error(`failed to copy: failed to ingest blob ${blob}: lease does not exist: not found`);
        serving = commit;
      }, { reserved: true }),
      health: async commit => { assert.equal(serving, commit); },
      install: 'core',
    });
    // The reclaim runs in the retry window: right after the failed build is reported, before the retry builds.
    const outcome = await deployOnce(deployRecordPath(root), ports, line => {
      if (/retrying/.test(line)) reclaim ??= reclaimJobLeftovers(docker, { temporary: [], checkouts: [], verification: [], warmInUse, slots });
    });
    assert.ok(reclaim, 'a reclaim pass ran during the retry window');
    const swept = await reclaim;
    assert.equal(outcome, 'deployed');
    assert.deepEqual(pruned, [], 'no image or build cache is removed between the attempts');
    assert.match(swept.skipped ?? '', /deploy .*bbbbbbbbbbbb holds a heavy-job slot/, 'the reclaim skips: the deploy still holds its slot');
    assert.deepEqual(builds, [false, true], 'one retry, without build cache');
    const status = readControlPlaneRecord(controlPlaneRecordPath(root));
    assert.equal(status?.commit, next);
    assert.match(status?.retried ?? '', /retried once without build cache/);
    assert.ok(status?.retried?.includes(blob), 'status names the blob');
  } finally {
    if (saved === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = saved;
  }
});
