import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimVerbs, missingTrialVerbs } from '../src/host-shim.js';
import { readShardHosts, remoteShardSession, shardSshSession } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { defaultChildRun } from '../src/child-runner.js';
import { dockerCalls, dockerCount, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3825 AC-1: a check's Compose service image that exists in the coordinator's local Docker
// is sent to the compute host before run-check, keyed by image id, and skipped when the host
// already holds that id; the helper accepts an image only when the run's committed Compose file
// names it (refusing any other name and build); an older helper without the new receive-image
// version still takes checks needing no private image; and clean removes check images unused for 7 days.

const proof = 'unit:check-private-image-sent-once';
const trialImage = 'mainworks-trial:private-img-unit';
const privateImage = 'hwd-legacy-oracle:pinned';
const privateIdV1 = `sha256:${'a1'.repeat(32)}`;
const privateIdV2 = `sha256:${'b2'.repeat(32)}`;
const target = 'gy-compute@box';

let hosts: ShardHostsFixture;
before(async () => {
  hosts = await shardHosts('check-private-image-unit', ['box'], {
    [trialImage]: `sha256:${'3825'.repeat(16)}`,
    [privateImage]: privateIdV1,
  });
});

const runWithHosts: ChildRun = (command, args, options) =>
  defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });

const hostShim = (command: string, input = '') => spawnSync(hosts.shim, ['--home', hosts.home('box')], {
  encoding: 'utf8',
  input,
  env: { PATH: `${join(hosts.root, 'hosts', 'box', 'bin')}:/usr/bin:/bin`, HOME: hosts.home('box'), SSH_ORIGINAL_COMMAND: command, GRAPHYARD_HOST_FLOOR_GB: '0' },
});

test(`${proof} — sends a local check image once by image id, skips when host has that id, and resends on a new id`, { timeout: 120_000 }, async () => {
  const { root, sha } = await shardRepository('check-private-image-repo', [], {
    'compose.json': JSON.stringify({ services: { oracle: { image: privateImage, expose: [8080] } } }),
  });

  // Run 1: host lacks privateIdV1 -> coordinator sends it once before run-check.
  const session1 = remoteShardSession({ root, sha, image: trialImage, run: runWithHosts, deadline: Date.now() + 60_000 });
  try {
    const end1 = await session1.check(target, { file: 'compose.json', services: [{ service: 'oracle', port: 8080 }], argv: ['true'], cpus: 1 });
    assert.equal(end1.status, 0, end1.out);
  } finally {
    await session1.close();
  }
  const hostState = () => JSON.parse(readFileSync(join(hosts.state('box'), 'state.json'), 'utf8')) as { images: Record<string, string> };
  assert.equal(hostState().images[privateImage], privateIdV1, 'host received the private image with its exact id');
  const loadsAfterFirst = dockerCount(hosts.state('box'), 'load');
  const savesAfterFirst = dockerCount(hosts.localState, 'save');
  // 1 load for warm image + 1 load for private check image.
  assert.equal(loadsAfterFirst, 2, `expected warm + private image loads, got ${dockerCalls(hosts.state('box')).join(', ')}`);

  // Run 2: host already has privateIdV1 -> transfer is skipped (no docker save / load).
  const session2 = remoteShardSession({ root, sha, image: trialImage, run: runWithHosts, deadline: Date.now() + 60_000 });
  try {
    const end2 = await session2.check(target, { file: 'compose.json', services: [{ service: 'oracle', port: 8080 }], argv: ['true'], cpus: 1 });
    assert.equal(end2.status, 0, end2.out);
  } finally {
    await session2.close();
  }
  assert.equal(dockerCount(hosts.state('box'), 'load'), loadsAfterFirst, 'second run skips docker load when host already has image id');
  assert.equal(dockerCount(hosts.localState, 'save'), savesAfterFirst, 'second run skips docker save when host already has image id');

  // Run 3: coordinator rebuilds privateImage to privateIdV2 -> host lacks privateIdV2, so it is transferred.
  const localJson = JSON.parse(readFileSync(join(hosts.localState, 'state.json'), 'utf8'));
  localJson.images[privateImage] = privateIdV2;
  writeFileSync(join(hosts.localState, 'state.json'), JSON.stringify(localJson));
  const session3 = remoteShardSession({ root, sha, image: trialImage, run: runWithHosts, deadline: Date.now() + 60_000 });
  try {
    const end3 = await session3.check(target, { file: 'compose.json', services: [{ service: 'oracle', port: 8080 }], argv: ['true'], cpus: 1 });
    assert.equal(end3.status, 0, end3.out);
  } finally {
    await session3.close();
  }
  assert.equal(hostState().images[privateImage], privateIdV2, 'host updated to the new image id');
  assert.equal(dockerCount(hosts.state('box'), 'load'), loadsAfterFirst + 1, 'rebuilt image id is transferred');
});

test(`${proof} — helper accepts an image only when the run's committed Compose file names it and refuses other names and build`, async () => {
  const run = 'trial-imgcheck1';
  const repo = join(hosts.home('box'), '.graphyard', 'runs', run, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, '..', 'image'), 'graphyard-warm:000000000000-none');
  await gitRepo({ root: repo, message: 'fixture', files: {
    'compose.json': JSON.stringify({ services: { oracle: { image: privateImage, expose: [8080] } } }),
    'build.json': JSON.stringify({ services: { oracle: { image: privateImage, build: { context: '.' }, expose: [8080] } } }),
  } });

  const refused = [
    `receive-image ${privateImage}`,
    `receive-image ${run} compose.json unlisted-image:latest ${privateIdV1}`,
    `receive-image ${run} compose.json unlisted-image:latest ${privateIdV1} check`,
    `receive-image trial-missing compose.json ${privateImage} ${privateIdV1} check`,
    `receive-image ${run} build.json ${privateImage} ${privateIdV1} check`,
  ];
  for (const command of refused) {
    const result = hostShim(command);
    assert.equal(result.status, 1, `${command}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /graphyard-host-shim refuses/, command);
  }
});

test(`${proof} — clean removes received check images unused for 7 days and keeps recently used ones`, () => {
  const checkImagesDir = join(hosts.home('box'), '.graphyard', 'check-images');
  assert.ok(existsSync(checkImagesDir), 'check-images tracking directory exists on host');
  const markers = readdirSync(checkImagesDir);
  assert.ok(markers.length >= 1, 'at least one check-image marker exists');

  // Make a dummy run directory to clean.
  const runRecent = 'trial-clean01';
  mkdirSync(join(hosts.home('box'), '.graphyard', 'runs', runRecent), { recursive: true });
  const recentClean = hostShim(`clean ${runRecent}`);
  assert.equal(recentClean.status, 0, recentClean.stderr);
  const afterRecent = JSON.parse(readFileSync(join(hosts.state('box'), 'state.json'), 'utf8')) as { images: Record<string, string> };
  assert.equal(afterRecent.images[privateImage], privateIdV2, 'recently used check image is kept by clean');

  // Backdate all markers by 8 days and run clean again.
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
  for (const file of readdirSync(checkImagesDir)) {
    utimesSync(join(checkImagesDir, file), eightDaysAgo, eightDaysAgo);
  }
  const runExpired = 'trial-clean02';
  mkdirSync(join(hosts.home('box'), '.graphyard', 'runs', runExpired), { recursive: true });
  const expiredClean = hostShim(`clean ${runExpired}`);
  assert.equal(expiredClean.status, 0, expiredClean.stderr);
  const afterExpired = JSON.parse(readFileSync(join(hosts.state('box'), 'state.json'), 'utf8')) as { images: Record<string, string> };
  assert.equal(afterExpired.images[privateImage], undefined, 'check image unused for 7 days is removed by clean');
  assert.deepEqual(readdirSync(checkImagesDir), [], 'expired markers are removed');
});

test(`${proof} — older helper with receive-image:2 stays ready and takes checks needing no private image`, async () => {
  const v2Verbs = hostShimVerbs.map(verb => (verb.startsWith('receive-image:') ? 'receive-image:2' : verb));
  assert.deepEqual(missingTrialVerbs({ shim: null, verbs: v2Verbs }), [], 'receive-image:2 stays ready under GY-3804');

  const dir = await temporaryDirectory('older-v2-check');
  const v2Host = 'gy-compute@v2-box';
  const calls: string[] = [];
  const run: ChildRun = async (command, args) => {
    if (command === 'ssh') {
      if (args.includes('-G')) return 'hostname 127.0.0.1\nuser gy-compute\n';
      if (args.includes('-fNM') || args.includes('-O')) return '';
      const verb = args.at(-1)!;
      calls.push(verb);
      if (verb === 'probe') return [`shim ${'9'.repeat(64)}`, `verbs ${v2Verbs.join(' ')}`, 'user 1001 gy-compute', 'compose 2.fixture', 'cores 8', 'load 0.5', 'cpu 10 0 10 80 0 0 0 0 0 0', 'runs 0'].join('\n');
      if (verb.startsWith('prepare-run ')) return 'run trial-v2check1\n';
      if (verb.startsWith('clean ')) return '';
      throw new Error(`unexpected ssh verb: ${verb}`);
    }
    if (command === 'sh') {
      const script = args[1] ?? '';
      if (script.includes('run-check ')) {
        calls.push('run-check');
        return 'ok\nmainworks-check services 5\nmainworks-check command 10\nmainworks-check teardown 2\nmainworks-check exit 0\n';
      }
      return [`shim ${hostShimDigest}`, `verbs ${hostShimVerbs.join(' ')}`, 'user 1001 gy-compute', 'compose 2.fixture', 'cores 4', 'load 0.5', 'cpu 10 0 10 80 0 0 0 0 0 0', 'runs 0'].join('\n');
    }
    if (command === 'git') {
      if (args.includes('cat-file') && args.includes('blob')) return JSON.stringify({ services: { db: { image: privateImage, expose: [5432] } } });
      if (args.includes('show')) return '{"lockfileVersion":3}';
      return '';
    }
    if (command === 'docker') {
      if (args[0] === 'image' && args[1] === 'inspect') return privateIdV1;
      if (args[0] === 'images') return '';
      return '';
    }
    return '';
  };

  const transport = shardSshSession(run, join(dir, 'known_hosts'));
  const readings = await readShardHosts([v2Host], run, 4, transport);
  const v2Reading = readings.find(r => r.name === v2Host)!;
  assert.equal(v2Reading.away, false, v2Reading.reason);
  const session = remoteShardSession({ root: dir, sha: 'a'.repeat(40), image: trialImage, run, deadline: Date.now() + 30_000, transport, hosts: readings });
  try {
    const end = await session.check(v2Host, { file: 'compose.json', services: [{ service: 'db', port: 5432 }], argv: ['true'], cpus: 1 });
    assert.equal(end.status, 0);
  } finally {
    await session.close();
  }
  assert.ok(!calls.some(c => c.startsWith('receive-image ')), `older helper must not receive v3 receive-image calls: ${calls.join(', ')}`);
  assert.ok(calls.includes('run-check'), 'older helper still ran run-check');
});
