import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { measureDiskUseByKind, reclaimJobLeftovers } from '../src/daemon/disk-headroom.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema, type MasterConfig } from '../src/master/profiles.js';
import * as remoteShards from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3745: one warm image is committed per trial image digest and lockfile, and nothing removed old
// ones on the coordinator. The loop's leftovers sweep now keeps only the current trial image's warm
// images, the two newest and any a running trial uses. The Docker CLI is a stub on PATH keeping its images in a file.

const GB = 1_000_000_000;
const current = 'aaaaaaaaaaaa', old = ['111111111111', '222222222222', '333333333333', '444444444444', '555555555555'];
const lock = (n: number) => String(n).repeat(12);
// Newest first by creation: the two newest are stale digests, then the current digest's, then three older stale ones.
const warmImages = [
  { tag: `${old[0]}-${lock(1)}`, created: '2026-11-23 18:00:00 +0000 UTC' },
  { tag: `${old[1]}-${lock(2)}`, created: '2026-11-23 17:00:00 +0000 UTC' },
  { tag: `${current}-${lock(3)}`, created: '2026-11-23 16:00:00 +0000 UTC' },
  { tag: `${old[2]}-${lock(4)}`, created: '2026-11-22 10:00:00 +0000 UTC' },
  { tag: `${old[3]}-none`, created: '2026-11-21 10:00:00 +0000 UTC' },
  { tag: `${old[4]}-${lock(5)}`, created: '2026-11-20 10:00:00 +0000 UTC' },
];

async function stubDocker() {
  const directory = await temporaryDirectory('warm-images-docker', tmpdir()), state = join(directory, 'state.json');
  writeFileSync(state, JSON.stringify({ images: [
    ...warmImages.map(image => ({ repository: 'graphyard-warm', tag: image.tag, created: image.created, size: '5GB' })),
    { repository: 'postgres', tag: '17', created: '2026-11-01 10:00:00 +0000 UTC', size: '1GB' },
  ] }));
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), file = ${JSON.stringify(state)}, args = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === 'image' && args[1] === 'inspect') { console.log('sha256:${current}' + 'b'.repeat(52)); process.exit(0); }
if (args[0] === 'images') {
  const format = args[args.indexOf('--format') + 1];
  for (const i of s.images.filter(i => i.repository === args[1])) console.log(format.replace('{{.CreatedAt}}', i.created).replace('{{.Repository}}', i.repository).replace('{{.Tag}}', i.tag));
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'rm') {
  const [repository, tag] = args[2].split(':');
  s.images = s.images.filter(i => !(i.repository === repository && i.tag === tag));
  fs.writeFileSync(file, JSON.stringify(s));
  process.exit(0);
}
if (args[0] === 'system' && args[1] === 'df') { console.log(JSON.stringify({ Images: s.images.map(i => ({ Repository: i.repository, Tag: i.tag, Size: i.size })), BuildCache: [] })); process.exit(0); }
process.exit(0);
`);
  chmodSync(join(directory, 'docker'), 0o755);
  const run: ChildRun = (command, args, options = {}) => defaultChildRun(command, args, { ...options, env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });
  const warm = () => (JSON.parse(readFileSync(state, 'utf8')).images as { repository: string; tag: string }[]).filter(i => i.repository === 'graphyard-warm').map(i => i.tag).sort();
  return { run, warm };
}

/** The warm images running trials use (absent on the base tip, where nothing tracks them). */
const inUse = (remoteShards as Record<string, unknown>).warmImagesInUse as Map<string, number> | undefined;

test('integration:prune-local-warm-images — the leftovers sweep keeps the current digest\'s warm images, the two newest and one a running trial uses, and removes the rest', async () => {
  const docker = await stubDocker();
  const running = `${old[3]}-none`;
  inUse?.set(`graphyard-warm:${running}`, 1);
  try {
    const removed = await reclaimJobLeftovers(docker.run, { temporary: [], checkouts: [], verification: [] });
    assert.deepEqual(docker.warm(), [`${old[0]}-${lock(1)}`, `${old[1]}-${lock(2)}`, running, `${current}-${lock(3)}`].sort(), 'only the kept warm images stay');
    assert.deepEqual(removed.sort(), [`image graphyard-warm:${old[2]}-${lock(4)}`, `image graphyard-warm:${old[4]}-${lock(5)}`].sort());
  } finally { inUse?.delete(`graphyard-warm:${running}`); }
  // A second sweep, the trial ended: its warm image goes too; nothing else does.
  assert.deepEqual(await reclaimJobLeftovers(docker.run, { temporary: [], checkouts: [], verification: [] }), [`image graphyard-warm:${running}`]);
  assert.deepEqual(docker.warm(), [`${old[0]}-${lock(1)}`, `${old[1]}-${lock(2)}`, `${current}-${lock(3)}`].sort());
});

test('e2e:prune-local-warm-images — one loop reclaim leaves only the kept warm images and master status diskHeadroom shows the graphyard-warm total drop', async () => {
  const docker = await stubDocker();
  const root = await temporaryDirectory('warm-images-root');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const credentialFile = join(await temporaryDirectory('warm-images-credentials'), 'coordinator.token');
  writeFileSync(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({
    version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/warm-images', baseBranch: 'main', hostId: 'coord-a', masterAgentName: 'graphyard-master-warm-images', workers: [],
    run: { diskFloorGb: 30, worktreeRoot: await temporaryDirectory('warm-images-wt-root') },
  }) as MasterConfig;
  let clock = Date.parse('2030-05-01T00:00:00Z'), sweep = false;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, dispatchTick: async () => {}, recordSession: async () => {},
    persist: current => writeDaemonState(config, current),
    diskVolumes: async () => [{ path: '/home', freeBytes: 90 * GB }],
    diskUseByKind: () => measureDiskUseByKind({ worktrees: [], trialRuns: [], cliReleases: [] }, docker.run),
    // The sweep is not yet due on the first cycle (it runs at most once an hour), then runs.
    reclaimJobLeftovers: async () => sweep ? reclaimJobLeftovers(docker.run, { temporary: [], checkouts: [], verification: [] }) : [],
  };
  const warmTotal = async () => ((await masterStatusReport(root, config, async () => { throw new TypeError('fetch failed'); }, async () => '')).diskHeadroom as { top: { kind: string; bytes: number }[] })
    .top.find(entry => entry.kind === 'images: graphyard-warm')?.bytes ?? 0;

  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, () => clock);
  assert.equal(await warmTotal(), 30 * GB, 'six stale and current warm images before the reclaim');

  clock += 3_600_000;
  sweep = true;
  await runCycle(config, state, effects, () => clock);
  assert.deepEqual(docker.warm(), [`${old[0]}-${lock(1)}`, `${old[1]}-${lock(2)}`, `${current}-${lock(3)}`].sort(), 'one reclaim leaves only the kept warm images');
  assert.equal(await warmTotal(), 15 * GB, 'master status shows the graphyard-warm total drop');
});
