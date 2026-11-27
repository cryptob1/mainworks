import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { heatFallbacksInLastHour, heatRereadDelayMs, readHeatFallbacks, readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import type { startCheckServices } from '../src/compose-preview.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCalls, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';
import { freePort } from './helpers/http-server.js';

// GY-3948 AC-1: a declared check with a host whose first probe is hot and second is cool runs on
// that host; a host hot on both probes falls back to this machine with both values in the reason
// and increments the heat fallback count.
// GY-3953: both run on a fake clock. The host's probe takes its five sensor samples through a `sleep`
// that records its interval and returns at once, and the coordinator's ten-second reread waits on an
// injected sleep, so nothing waits on the real clock. The check's services start in the host's
// stand-in Docker, as in declared-check-runs-on-a-host: naming docker keeps this file on this machine
// (localOnlyTestPattern); on a remote shard the stand-in's postgres never accepted and the check
// waited out its 120 s (batch gate runs on e7dff0c2).

const proof = 'integration:check-runs-on-host-after-one-hot-sample';
const image = 'mainworks-trial:gy-3948-check';
const target = 'gy-compute@box';
let hosts: ShardHostsFixture;
let repository: { root: string; sha: string };
let port: number;
let ran: string;
let sensor: string;
let sampleWaits: string;
const previousImage = process.env.GRAPHYARD_TRIAL_IMAGE;

before(async () => {
  hosts = await shardHosts('gy-3948-check-host', ['box'], { [image]: `sha256:${'3948'.repeat(16)}` });
  port = await freePort();
  ran = join(hosts.root, 'ran.jsonl');
  // The host's CPU sensor, which its probe samples five times, and its `sleep`, which records each wait.
  sensor = join(hosts.root, 'hwmon', 'hwmon0');
  await mkdir(sensor, { recursive: true });
  await writeFile(join(sensor, 'name'), 'k10temp\n');
  sampleWaits = join(hosts.root, 'sample-waits.log');
  await writeFile(join(hosts.root, 'hosts', 'box', 'bin', 'sleep'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(sampleWaits)}\n`);
  await chmod(join(hosts.root, 'hosts', 'box', 'bin', 'sleep'), 0o755);
  repository = await shardRepository('gy-3948-check-repo', [], {
    'graphyard.json': JSON.stringify({
      delivery: {
        mergeGate: {
          perCandidate: [],
          preMerge: [{
            check: 'db',
            command: 'node scripts/needs-postgres.mjs',
            source: 'script',
            reason: 'fixture',
            services: [{ file: 'compose.json', service: 'postgres', port }],
          }],
        },
      },
    }),
    'compose.json': JSON.stringify({ services: { postgres: { image: 'postgres:16', expose: [port] } } }),
    'scripts/needs-postgres.mjs': `import { connect } from 'node:net';
import { appendFileSync } from 'node:fs';
const host = process.env.GRAPHYARD_SERVICE_POSTGRES_HOST, port = Number(process.env.GRAPHYARD_SERVICE_POSTGRES_PORT);
connect({ host, port }).once('connect', () => {
  appendFileSync(${JSON.stringify(ran)}, JSON.stringify({ cwd: process.cwd(), host, port }) + '\\n');
  console.log('postgres answered at ' + host + ':' + port);
  process.exit(0);
}).once('error', error => { console.error('no postgres: ' + error.message); process.exit(1); });
`,
  });
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});

after(() => {
  if (previousImage === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE;
  else process.env.GRAPHYARD_TRIAL_IMAGE = previousImage;
});

async function runCheckWithTemperatures(sequence: number[]) {
  await rm(ran, { force: true });
  await rm(sampleWaits, { force: true });
  const local: string[][] = [];
  const started: unknown[] = [];
  const rereadWaits: number[] = [];
  let probeCall = 0;
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node') { local.push(args); return 'ok'; }
    // This machine's own probe (sh) samples its real sensors without waiting between samples.
    const probe = command === 'sh' ? { GRAPHYARD_PROBE_SAMPLE_SECONDS: '0' } : {};
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, ...probe, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const services: typeof startCheckServices = async request => {
    started.push(request);
    return { network: 'container:local-postgres', close: async () => {} };
  };
  const result = await runTrial({
    root: repository.root,
    base: await temporaryDirectory('gy-3948-check-base'),
    mergeSha: repository.sha,
    changedFiles: ['scripts/needs-postgres.mjs'],
    timeoutMs: 180_000,
    cores: 2,
    run,
    retries: 0,
    services,
    remote: {
      hosts: [target],
      heatSleep: async ms => { rereadWaits.push(ms); },
      read: async (named, transport) => {
        await writeFile(join(sensor, 'temp1_input'), `${sequence[Math.min(probeCall++, sequence.length - 1)]! * 1000}\n`);
        // The host's free cores are fixed; its heat is what its probe's five samples read.
        return (await readShardHosts(named, run, 2, transport)).map((reading, index) =>
          index === 0 ? reading : { ...reading, cores: 24, busy: 2, steal: 0 });
      },
    },
  });
  const lines = existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { cwd: string }) : [];
  const waits = existsSync(sampleWaits) ? readFileSync(sampleWaits, 'utf8').split('\n').filter(Boolean) : [];
  return { result, lines, probeCall, started, rereadWaits, sampleWaits: waits, localCheck: local.filter(args => args.includes('scripts/needs-postgres.mjs')) };
}

test(`${proof} — a host whose first probe is hot and second is cool runs the declared check there`, { timeout: 180_000 }, async () => {
  const { result, lines, probeCall, started, rereadWaits, sampleWaits, localCheck } = await runCheckWithTemperatures([88, 72]);
  assert.equal(result.build, 'pass', result.logTail);
  assert.equal(heatRereadDelayMs, 10_000);
  assert.deepEqual(rereadWaits, [10_000], 'the reread waited its ten seconds on the fake clock');
  assert.deepEqual(sampleWaits, Array(8).fill('0.5'), 'each of the two probes took five samples, waiting half a second between them on the fake clock');
  assert.deepEqual(result.tests, { passed: 1, failed: [], files: 1 }, result.logTail);
  assert.equal(probeCall, 2, 'coordinator re-read the hot host once');
  assert.equal(lines.length, 1, result.logTail);
  assert.ok(lines[0]!.cwd.startsWith(join(hosts.home('box'), '.graphyard', 'runs', 'trial-')), `check ran on host: ${lines[0]!.cwd}`);
  assert.deepEqual(localCheck, [], 'check did not fall back to coordinator');
  assert.deepEqual(started, [], 'no local Compose services started');
  assert.ok(dockerCalls(hosts.state('box')).includes('compose up postgres'), 'the host started the check\'s services');
  assert.equal(heatFallbacksInLastHour(readHeatFallbacks(repository.root)), 0);
});

test(`${proof} — a host hot on both probes falls back to coordinator naming both values and records a heat fallback`, { timeout: 180_000 }, async () => {
  const { result, probeCall, started, rereadWaits, sampleWaits, localCheck } = await runCheckWithTemperatures([95, 96]);
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(rereadWaits, [10_000]);
  assert.deepEqual(sampleWaits, Array(8).fill('0.5'));
  assert.deepEqual(result.tests, { passed: 1, failed: [], files: 1 }, result.logTail);
  assert.equal(probeCall, 2);
  assert.equal(started.length, 1);
  assert.equal(localCheck.length, 1);
  assert.match(result.logTail, /too hot \(95°C, then 96°C; limit 85°C\)/);
  assert.equal(heatFallbacksInLastHour(readHeatFallbacks(repository.root)), 1);
});
