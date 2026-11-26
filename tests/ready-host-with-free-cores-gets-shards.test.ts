import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimVerbs, missingTrialVerbs } from '../src/host-shim.js';
import {
  readShardHosts,
  remoteShardSession,
  runShardsOnHosts,
  shardSshSession,
  type PlacedHost,
} from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3928 AC-1: a ready host that offers every trial verb (including older supported verb
// revisions like run-shard:2) must receive shards when the coordinator has shards queued and
// the host has free cores.

const proof = 'unit:ready-host-with-free-cores-gets-shards';
const liveModernVerbs = 'probe:1 receive-pack:1 receive-image:3 prepare-run:2 run-shard:2 fetch-records:1 clean:1 run-session:1 update-shim:2 share:1';
const liveOldestVerbs = 'probe:1 receive-pack:1 receive-image:1 prepare-run:1 run-shard:2 fetch-records:1 clean:1';

const probeText = (shim: string, verbs: string, cores = 24) => [
  `shim ${shim}`,
  `verbs ${verbs}`,
  'user 1001 gy-compute',
  'compose 5.6.1',
  `cores ${cores}`,
  'load 0.50',
  'cpu 100 0 100 800 0 0 0 0 0 0',
  'runs 0',
].join('\n');

test(`${proof} — a ready host offering every trial verb (current, update-shim:2/run-shard:2, or oldest) receives shards when shards are queued and it has free cores`, async () => {
  const dir = await temporaryDirectory('ready-host-gets-shards');
  const sha = 'a'.repeat(40);
  const baseTip = 'b'.repeat(40);
  const image = 'mainworks-trial:unit';
  const imageDigest = `sha256:${'c'.repeat(64)}`;
  const lockfile = '{"lockfileVersion":3}';
  const lockHash = createHash('sha256').update(lockfile).digest('hex');
  const v1Tag = `graphyard-warm:${'c'.repeat(12)}-${lockHash.slice(0, 12)}`;
  const v2Tag = `graphyard-warm:${'c'.repeat(12)}-${lockHash.slice(0, 12)}-${baseTip.slice(0, 12)}`;

  const cases = [
    { name: 'gy-compute@modern-v2', shim: 'a'.repeat(64), verbs: liveModernVerbs, refusesNonce: true },
    { name: 'gy-compute@oldest-v1', shim: 'b'.repeat(64), verbs: liveOldestVerbs, refusesNonce: true },
    { name: 'gy-compute@current', shim: hostShimDigest, verbs: hostShimVerbs.join(' '), refusesNonce: false },
  ];

  for (const hostCase of cases) {
    assert.deepEqual(
      missingTrialVerbs({ shim: hostCase.shim, verbs: hostCase.verbs.split(' ') }),
      [],
      `${hostCase.name} must offer every trial verb`,
    );

    const localImages = new Set<string>([image, v1Tag, v2Tag]);
    const run: ChildRun = async (command, args) => {
      if (command === 'git') return lockfile;
      if (command === 'docker') {
        if (args[0] === 'image' && args[1] === 'inspect') return args.at(-1) === image ? imageDigest : `sha256:${'d'.repeat(64)}`;
        if (args[0] === 'images') return [...localImages].filter(tag => tag.startsWith('graphyard-warm:')).join('\n');
        return '';
      }
      if (command === 'ssh') {
        if (args.includes('-G')) return 'hostname 127.0.0.1\nuser gy-compute\n';
        if (args.includes('-fNM') || args.includes('-O')) return '';
        const verb = args.at(-1)!;
        if (verb === 'probe') return probeText(hostCase.shim, hostCase.verbs, 24);
        if (verb.startsWith('prepare-run ')) return 'run trial-ready01\n';
        if (verb.startsWith('fetch-records ')) return '{"file":"tests/a.test.ts","passed":true,"durationMs":1}\n';
        if (verb.startsWith('clean ')) return '';
        throw new Error(`unexpected ssh verb: ${verb}`);
      }
      if (command === 'sh') {
        const script = args[1] ?? '';
        if (script.includes('run-shard ')) {
          const hasNonce = /"nonce"\s*:/.test(script);
          if (hostCase.refusesNonce && hasNonce) {
            throw Object.assign(new Error('graphyard-host-shim refuses: run-shard trial-ready01 1'), {
              stderr: 'graphyard-host-shim refuses: run-shard trial-ready01 1\n',
              stdout: '',
              status: 1,
            });
          }
          if (!hostCase.refusesNonce) {
            const nonce = /"nonce":"([0-9a-f]+)"/.exec(script)?.[1];
            assert.ok(nonce, 'current helper must receive a per-run nonce');
            return `ok\nmainworks-verdict:${nonce} ${JSON.stringify({ status: 0, records: '{"file":"tests/a.test.ts","passed":true,"durationMs":1}\n' })}\n`;
          }
          return 'ok\n';
        }
        return probeText(hostShimDigest, hostShimVerbs.join(' '), 8);
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    };

    const transport = shardSshSession(run, join(dir, 'known_hosts'));
    const readings = await readShardHosts([hostCase.name], run, 8, transport);
    const remoteReading = readings[1]!;
    assert.equal(remoteReading.away, false, `${hostCase.name} must read ready: ${remoteReading.reason}`);

    const session = remoteShardSession({
      root: dir,
      sha,
      baseTip,
      image,
      run,
      deadline: Date.now() + 60_000,
      transport,
      hosts: readings,
    });
    try {
      const placed: PlacedHost<string>[] = [
        { name: readings[0]!.name, room: 2, reading: { ...readings[0]!, cores: 8, busy: 4, steal: 0, celsius: null } },
        { name: hostCase.name, room: 4, remote: hostCase.name, reading: { ...remoteReading, cores: 24, busy: 0, steal: 0, celsius: null } },
      ];
      const placement = await runShardsOnHosts({
        count: 4,
        hosts: placed,
        breadth: 2,
        run: async (host, index) => {
          if (!host.remote) return;
          const end = await session.run(host.remote, index, ['tests/a.test.ts'], (list, records) => ['node', list, records], 2);
          assert.equal(end.ok, true, `${hostCase.name} shard failed: ${end.out}`);
        },
      });
      const remoteCount = placement.ran.filter(name => name === hostCase.name).length;
      assert.ok(remoteCount > 0, `ready host ${hostCase.name} with free cores must receive shards while shards are queued (dropped=${JSON.stringify(placement.dropped)})`);
      assert.deepEqual(placement.dropped, [], `${hostCase.name} must not be dropped during shard execution`);
    } finally {
      await session.close();
    }
  }
});
