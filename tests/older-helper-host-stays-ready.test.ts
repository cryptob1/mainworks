import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimScript, hostShimVerbs, missingTrialVerbs, trialVerbs } from '../src/host-shim.js';
import { hostAddCommand, readHostReadings } from '../src/hosts.js';
import {
  outdatedShimAttention,
  readShardHosts,
  remoteShardSession,
  runShardsOnHosts,
  shardSshSession,
  warmCommitOnHosts,
  type PlacedHost,
} from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3804 AC-1: a compute host whose probe lists receive-image:1 and prepare-run:1 (without version 2)
// stays ready, shows the older-helper notice (never away), and receives shards and declared checks
// through the v1 calls with the pre-GY-3627 2-part warm image; a host offering version 2 uses it.

const proof = 'unit:older-helper-host-stays-ready';
const v1Verbs = 'probe:1 receive-pack:1 receive-image:1 prepare-run:1 run-shard:2 fetch-records:1 clean:1';
const v2Verbs = hostShimVerbs.join(' ');
const v1TagPattern = /^graphyard-warm:[0-9a-f]{12}-(?:[0-9a-f]{12}|none)$/;
const v2TagPattern = /^graphyard-warm:[0-9a-f]{12}-(?:[0-9a-f]{12}|none)-[0-9a-f]{12}$/;

const probeOutput = (shim: string, verbs: string) => [
  `shim ${shim}`,
  `verbs ${verbs}`,
  'user 1001 gy-compute',
  'compose 5.6.1',
  'cores 8',
  'load 0.50',
  'cpu 100 0 100 800 0 0 0 0 0 0',
  'runs 0',
].join('\n');

test(`${proof} — a host with receive-image:1 and prepare-run:1 stays ready with the older-helper notice; a host lacking a verb with no older form reads away`, async () => {
  const dir = await temporaryDirectory('older-helper-status');
  const file = join(dir, 'hosts.json');
  const v1Host = 'gy-compute@vish-msi-compute';
  const v2Host = 'gy-compute@new-compute';
  const tooOldHost = 'gy-compute@too-old';
  await writeFile(file, JSON.stringify([
    { target: v1Host, addedAt: '2026-11-20T00:00:00.000Z' },
    { target: v2Host, addedAt: '2026-11-20T00:00:00.000Z' },
    { target: tooOldHost, addedAt: '2026-11-20T00:00:00.000Z' },
  ]));

  const run: ChildRun = async (command, args) => {
    if (command === 'sh') return probeOutput(hostShimDigest, v2Verbs);
    if (command === 'ssh') {
      const target = args.find(arg => arg.startsWith('gy-compute@'));
      if (target === v1Host) return probeOutput('1'.repeat(64), v1Verbs);
      if (target === v2Host) return probeOutput(hostShimDigest, v2Verbs);
      if (target === tooOldHost) return probeOutput('2'.repeat(64), v1Verbs.replace('run-shard:2', 'run-shard:1'));
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const readings = await readHostReadings([], { file, knownHosts: join(dir, 'known_hosts'), run, local: 'here' });
  const v1 = readings.find(reading => reading.host === v1Host)!;
  const v2 = readings.find(reading => reading.host === v2Host)!;
  const tooOld = readings.find(reading => reading.host === tooOldHost)!;

  assert.equal(v1.away, false, `v1 host must stay ready, got away: ${v1.reason}`);
  assert.equal(v1.update, undefined);
  assert.equal(v1.older, true);
  assert.equal(v2.away, false);
  assert.equal(v2.older, undefined);
  assert.equal(tooOld.away, true, 'a host lacking a verb with no older form is still refused');
  assert.equal(tooOld.update, true);
  assert.match(tooOld.reason ?? '', /lacks run-shard:2/);

  const attention = outdatedShimAttention([v1, v2]);
  assert.equal(attention.length, 1);
  assert.equal(attention[0]!.text, `${v1Host} runs an older helper: run ${hostAddCommand(v1Host)} to update it`);
});

test(`${proof} — placement uses both a v1 host and a v2 host, sending v1 calls with the 2-part image to the v1 host and v2 calls with the 3-part image to the v2 host for shards, checks and warm pushes`, async () => {
  const dir = await temporaryDirectory('older-helper-placement');
  const v1Host = 'gy-compute@v1-host';
  const v2Host = 'gy-compute@v2-host';
  const sha = 'a'.repeat(40);
  const baseTip = 'b'.repeat(40);
  const image = 'mainworks-trial:unit';
  const imageDigest = `sha256:${'c'.repeat(64)}`;
  const lockfile = '{"lockfileVersion":3}';
  const lockHash = createHash('sha256').update(lockfile).digest('hex');
  const expectedV1Tag = `graphyard-warm:${'c'.repeat(12)}-${lockHash.slice(0, 12)}`;
  const expectedV2Tag = `graphyard-warm:${'c'.repeat(12)}-${lockHash.slice(0, 12)}-${baseTip.slice(0, 12)}`;

  const localImages = new Set<string>([image]);
  const hostImages: Record<string, Set<string>> = { [v1Host]: new Set(), [v2Host]: new Set() };
  const calls: { host: string; verb: string; pipeline?: string }[] = [];
  const dockerBuildScripts: { tag?: string; script: string }[] = [];
  let pendingBuildScript: string | null = null;

  const handleShim = (target: string, verb: string, pipeline?: string): string => {
    calls.push({ host: target, verb, ...(pipeline ? { pipeline } : {}) });
    if (verb === 'probe') return target === v1Host ? probeOutput('1'.repeat(64), v1Verbs) : probeOutput(hostShimDigest, v2Verbs);
    if (verb.startsWith('prepare-run ')) {
      const [, , , tag] = verb.split(' ');
      if (target === v1Host && !v1TagPattern.test(tag!)) throw Object.assign(new Error(`graphyard-host-shim refuses: ${verb}`), { stderr: `graphyard-host-shim refuses: ${verb}\n`, status: 1 });
      if (target === v2Host && !v2TagPattern.test(tag!)) throw Object.assign(new Error(`graphyard-host-shim refuses: ${verb}`), { stderr: `graphyard-host-shim refuses: ${verb}\n`, status: 1 });
      if (!hostImages[target]!.has(tag!)) return 'need-image\n';
      return `run trial-${target === v1Host ? 'v1run01' : 'v2run01'}\n`;
    }
    if (verb.startsWith('receive-image ')) {
      const [, tag] = verb.split(' ');
      if (target === v1Host && !v1TagPattern.test(tag!)) throw Object.assign(new Error(`graphyard-host-shim refuses: ${verb}`), { stderr: `graphyard-host-shim refuses: ${verb}\n`, status: 1 });
      if (target === v2Host && !v2TagPattern.test(tag!)) throw Object.assign(new Error(`graphyard-host-shim refuses: ${verb}`), { stderr: `graphyard-host-shim refuses: ${verb}\n`, status: 1 });
      hostImages[target]!.add(tag!);
      return '';
    }
    if (verb.startsWith('run-shard ')) return 'ok\n';
    if (verb.startsWith('fetch-records ')) return '{"file":"tests/a.test.ts","passed":true,"durationMs":1}\n';
    if (verb.startsWith('run-check ')) return 'check output\nmainworks-check services 10\nmainworks-check command 20\nmainworks-check teardown 5\nmainworks-check exit 0\n';
    if (verb.startsWith('clean ')) return '';
    throw new Error(`unexpected shim verb on ${target}: ${verb}`);
  };

  const run: ChildRun = async (command, args) => {
    if (command === 'git') {
      if (args.includes('show') && args.at(-1)?.endsWith(':package-lock.json')) return lockfile;
      if (args.includes('cat-file')) return '';
      if (args.includes('merge-base')) return '';
      return '';
    }
    if (command === 'docker') {
      if (args[0] === 'image' && args[1] === 'inspect') {
        const tag = args.at(-1)!;
        if (!localImages.has(tag)) throw new Error(`No such image: ${tag}`);
        return tag === image ? imageDigest : `sha256:${'d'.repeat(64)}`;
      }
      if (args[0] === 'images') return [...localImages].filter(tag => tag.startsWith('graphyard-warm:')).join('\n');
      if (args[0] === 'commit') {
        const tag = args.at(-1)!;
        localImages.add(tag);
        if (pendingBuildScript) dockerBuildScripts.push({ tag, script: pendingBuildScript });
        pendingBuildScript = null;
        return '';
      }
      if (args[0] === 'rm') return '';
      return '';
    }
    if (command === 'ssh') {
      if (args.includes('-G')) return 'hostname 127.0.0.1\nuser gy-compute\n';
      if (args.includes('-fNM') || args.includes('-O')) return '';
      const target = args.find(arg => arg.startsWith('gy-compute@'))!;
      const verb = args.at(-1)!;
      return handleShim(target, verb);
    }
    if (command === 'sh') {
      const script = args[1] ?? '';
      if (script.includes('docker run -i --name graphyard-warm-')) {
        pendingBuildScript = script;
        return '';
      }
      const sshTargetMatch = script.match(/gy-compute@(?:v1-host|v2-host)/);
      if (sshTargetMatch) {
        const target = sshTargetMatch[0];
        const verbMatch = script.match(/'((?:receive-image|run-shard|run-check) [^']+)'\s*$/);
        if (verbMatch) return handleShim(target, verbMatch[1]!, script);
      }
      return probeOutput(hostShimDigest, v2Verbs);
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const transport = shardSshSession(run, join(dir, 'known_hosts'));
  const readings = await readShardHosts([v1Host, v2Host], run, 4, transport);
  const v1Reading = readings.find(reading => reading.name === v1Host)!;
  const v2Reading = readings.find(reading => reading.name === v2Host)!;
  assert.equal(v1Reading.away, false, v1Reading.reason);
  assert.equal(v2Reading.away, false, v2Reading.reason);

  const session = remoteShardSession({ root: dir, sha, baseTip, image, run, deadline: Date.now() + 60_000, transport, hosts: readings });
  try {
    const placed: PlacedHost<string>[] = [
      { name: readings[0]!.name, room: 1, reading: readings[0]! },
      { name: v1Host, room: 1, remote: v1Host, reading: { ...v1Reading, cores: 8, busy: 0, steal: 0 } },
      { name: v2Host, room: 1, remote: v2Host, reading: { ...v2Reading, cores: 8, busy: 0, steal: 0 } },
    ];
    const placement = await runShardsOnHosts({
      count: 2,
      hosts: placed,
      breadth: 2,
      run: async (host, index) => {
        assert.ok(host.remote, 'both shards should be placed on the remote hosts');
        const end = await session.run(host.remote, index, ['tests/a.test.ts'], (list, records) => ['node', list, records], 2);
        assert.equal(end.ok, true);
      },
    });
    assert.deepEqual([...placement.ran].sort(), [v1Host, v2Host], 'both the v1 host and the v2 host received shards');

    // Declared checks also run on both hosts through their respective helper versions.
    const v1Check = await session.check(v1Host, { file: 'compose.yaml', services: [{ service: 'db', port: 5432 }], argv: ['npm', 'test'], cpus: 2 });
    const v2Check = await session.check(v2Host, { file: 'compose.yaml', services: [{ service: 'db', port: 5432 }], argv: ['npm', 'test'], cpus: 2 });
    assert.equal(v1Check.status, 0);
    assert.equal(v2Check.status, 0);
  } finally {
    await session.close();
  }

  // Assert exact calls made per host.
  const v1Prepares = calls.filter(call => call.host === v1Host && call.verb.startsWith('prepare-run ')).map(call => call.verb);
  const v2Prepares = calls.filter(call => call.host === v2Host && call.verb.startsWith('prepare-run ')).map(call => call.verb);
  const v1Receives = calls.filter(call => call.host === v1Host && call.verb.startsWith('receive-image ')).map(call => call.verb);
  const v2Receives = calls.filter(call => call.host === v2Host && call.verb.startsWith('receive-image ')).map(call => call.verb);

  assert.ok(v1Prepares.length >= 2 && v1Prepares.every(verb => verb.endsWith(` ${expectedV1Tag}`)), `v1 host must get 2-part tag in prepare-run: ${JSON.stringify(v1Prepares)}`);
  assert.deepEqual(v1Receives, [`receive-image ${expectedV1Tag}`], 'v1 host must get 2-part tag in receive-image');
  assert.ok(v2Prepares.length >= 2 && v2Prepares.every(verb => verb.endsWith(` ${expectedV2Tag}`)), `v2 host must get 3-part tag in prepare-run: ${JSON.stringify(v2Prepares)}`);
  assert.deepEqual(v2Receives, [`receive-image ${expectedV2Tag}`], 'v2 host must get 3-part tag in receive-image');

  const v1Build = dockerBuildScripts.find(entry => entry.tag === expectedV1Tag);
  const v2Build = dockerBuildScripts.find(entry => entry.tag === expectedV2Tag);
  assert.ok(v1Build, 'v1 warm image was built with the 2-part tag');
  assert.ok(v1Build.script.includes('npm ci') && !v1Build.script.includes('/warm/dist'), 'v1 warm image is prepared as before GY-3627');
  assert.ok(v2Build && v2Build.script.includes('/warm/dist'), 'v2 warm image is prepared with /warm/dist and compile cache');

  // warmCommitOnHosts pushes the matching image form to each ready host without failing on the v1 host.
  const warmed = await warmCommitOnHosts({
    root: dir,
    commit: baseTip,
    image,
    hosts: [v1Host, v2Host],
    read: async (named, shared) => readShardHosts(named, run, 4, shared),
    run,
    deadline: Date.now() + 60_000,
  });
  assert.deepEqual([...warmed.pushed].sort(), [v1Host, v2Host], `both hosts receive their form of warm image; failed=${JSON.stringify(warmed.failed)}`);
  assert.deepEqual(warmed.failed, []);
});

test(`${proof} — fails when any helper trial verb version is raised without the coordinator keeping a branch for its previous version`, () => {
  // Parse the verbs directly from the helper script source so any bump in src/host-shim.ts is caught.
  const verbsMatch = /echo "verbs ([^"]+)"/.exec(hostShimScript);
  assert.ok(verbsMatch, 'helper source must print its verbs line');
  const scriptTrialVerbs = verbsMatch[1]!.split(' ').filter(verb => !/^(?:run-session|update-shim|share):/.test(verb));
  assert.deepEqual(scriptTrialVerbs, trialVerbs);

  // Baseline floor: run-shard:2 predates versioned compatibility (run-shard:1 is intentionally retired);
  // every other verb starts at 1. Any verb above its floor must accept version - 1 in missingTrialVerbs.
  const floor = (name: string) => (name === 'run-shard' ? 2 : 1);
  const unbacked = (verbs: readonly string[]) => verbs.flatMap(verb => {
    const [name, raw] = verb.split(':');
    const version = Number(raw);
    if (!name || !Number.isInteger(version) || version <= floor(name)) return [];
    const previous = `${name}:${version - 1}`;
    const probeVerbs = verbs.map(entry => (entry === verb ? previous : entry));
    return missingTrialVerbs({ shim: null, verbs: probeVerbs }, verbs).length > 0 ? [`${verb} lacks coordinator support for ${previous}`] : [];
  });

  assert.deepEqual(unbacked(scriptTrialVerbs), [], 'every bumped trial verb in the helper source must keep a coordinator branch for its previous version');

  // Sanity check that the guard itself fails when a verb's version is raised without a previous-version branch.
  const bumpedClean = scriptTrialVerbs.map(verb => (verb === 'clean:1' ? 'clean:2' : verb));
  assert.ok(unbacked(bumpedClean).some(problem => problem.includes('clean:2 lacks coordinator support for clean:1')));
});
