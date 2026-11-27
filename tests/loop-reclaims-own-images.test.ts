import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { diskHeadroomStep, diskHeadroomSummary, mainworksVolumes, reclaimMainworksLeftovers } from '../src/daemon/disk-headroom.js';
import { emptyDaemonState, type DaemonAction } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { trialBuilder } from '../src/install/trial-image.js';
import { trialImage } from '../src/merge-writer/trial-container.js';
import type { ChildRun } from '../src/child-runner.js';

const GB = 1e9;
test('integration:loop-reclaims-own-images — low Docker space removes only stale owned images and old owned cache, and reports the reclaimed space', async () => {
  const warmInUse = await temporaryDirectory('reclaim-images');
  const flight = `graphyard-warm:${'a'.repeat(12)}-none`;
  await writeFile(join(warmInUse, `${flight.slice('graphyard-warm:'.length)}.${process.pid}.12345678`), '');
  const current = trialImage(), stale = ['graphyard-warm:stale', 'graphyard-trial:stale'];
  const images = new Set([current, ...stale, 'huck-engineer:latest', flight, 'mainworks-trial:container-used']);
  const removed: string[] = [], removalAttempts: string[][] = [], prunes: string[][] = [];
  const cache = [{ builder: trialBuilder, age: 48 }, { builder: trialBuilder, age: 12 }, { builder: 'huck', age: 48 }];
  let free = 58 * GB;
  const run: ChildRun = async (command, args) => {
    assert.equal(command, 'docker');
    if (args[0] === 'ps' && args.includes('--quiet')) return 'container-id';
    if (args[0] === 'inspect') return 'sha256:container-image';
    if (args[0] === 'image' && args[1] === 'inspect') return args.at(-1) === 'mainworks-trial:container-used' ? 'sha256:container-image' : '';
    if (args[0] === 'images') return [...images].filter(image => image.startsWith(`${args[1]}:`)).map(image => args.at(-1)?.includes('CreatedAt') ? `2026-11-27\t${image}` : image).join('\n');
    if (args[0] === 'image' && args[1] === 'rm') {
      removalAttempts.push(args);
      const image = args[2]!;
      assert.equal(args.length, 3, 'never force removal');
      assert.notEqual(image, 'mainworks-trial:container-used', 'do not even untag a container image');
      assert.ok(images.delete(image)); removed.push(image); free += 10 * GB; return '';
    }
    if (args[0] === 'buildx') {
      assert.deepEqual(args, ['buildx', 'prune', '--builder', trialBuilder, '--filter', 'until=24h', '--force']);
      prunes.push(args);
      const index = cache.findIndex(entry => entry.builder === args[3] && entry.age > 24);
      if (index < 0) return 'Total: 0B';
      cache.splice(index, 1); free += 8 * GB; return 'Total: 8GB';
    }
    return '';
  };
  const config = masterConfigSchema.parse({ version: 1, url: 'http://localhost:1', credentialFile: '/token', cliPath: '/cli', repository: 'owner/repo', baseBranch: 'main', hostId: 'core', masterAgentName: 'master', workers: [] });
  const state = emptyDaemonState(config);
  let sample: (() => Promise<void>) | undefined;
  const cycle = { launcher: { submit: (_key: string, _holds: string[], body: (sink: DaemonAction[]) => Promise<void>) => { sample = () => body([]); return true; } }, config, state, now: () => Date.parse('2026-11-27T11:00:00Z'), performed: [], effects: {
    snapshot: async () => ({ work: [], now: new Date().toISOString() }), agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {},
    persist: async () => {},
    diskUseByKind: async () => [],
    diskVolumes: async () => [{ path: '/checkout', freeBytes: 600 * GB, totalBytes: 1000 * GB }, { path: '/docker', freeBytes: free, totalBytes: 1000 * GB, docker: true }],
    reclaimDisk: () => reclaimMainworksLeftovers(run, { temporary: [], checkouts: [], verification: [], warmInUse }),
  } };
  await diskHeadroomStep(cycle);
  await sample!(); // A slow hourly sample must not replace the post-reclaim free-space reading.
  assert.deepEqual(removed.sort(), stale.sort());
  assert.deepEqual(removalAttempts.map(args => args.join(' ')).sort(), stale.map(image => `image rm ${image}`).sort(), 'only stale images are even offered for deletion');
  assert.deepEqual([...images].sort(), [current, 'huck-engineer:latest', flight, 'mainworks-trial:container-used'].sort());
  assert.equal(prunes.length, 1, 'only the dedicated builder cache is pruned');
  assert.deepEqual(cache, [{ builder: trialBuilder, age: 12 }, { builder: 'huck', age: 48 }], 'recent cache and every other builder remain');
  const status = diskHeadroomSummary(state.diskHeadroom, state.diskUse) as any;
  assert.equal(status.freeBytes, 86 * GB);
  assert.equal(status.reclaimed.bytes, 28 * GB);
  assert.equal(status.reclaimed.freeBytes, 86 * GB);
  assert.ok(status.reclaimed.removed.includes('image graphyard-trial:stale'));
  assert.equal(state.diskHeadroom, null, 'the 15% reclaim threshold does not hold dispatch above the absolute floor');

  free = 150 * GB;
  await diskHeadroomStep(cycle);
  assert.equal(prunes.length, 1, 'at exactly 15% nothing is pruned');
});


test('integration:loop-reclaims-own-images — measure the Docker data volume, including its capacity, before deduplicating devices', async () => {
  const dockerRoot = await temporaryDirectory('docker-data-volume');
  const checkout = await temporaryDirectory('checkout-volume');
  const volumes = await mainworksVolumes([checkout], async (command, args) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args, ['info', '--format', '{{.DockerRootDir}}']);
    return dockerRoot;
  });
  assert.equal(volumes.length, 1, 'both fixture paths are on the same device');
  assert.equal(volumes[0]!.path, dockerRoot);
  assert.equal(volumes[0]!.docker, true);
  assert.ok(volumes[0]!.totalBytes! > 0);
  assert.ok(volumes[0]!.freeBytes! >= 0);
});
