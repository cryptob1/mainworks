import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { heatFallbacksInLastHour, readHeatFallbacks, readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import type { startCheckServices } from '../src/compose-preview.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';
import { freePort } from './helpers/http-server.js';

// GY-3948 AC-1: a declared check with a host whose first probe is hot and second is cool runs on
// that host; a host hot on both probes falls back to this machine with both values in the reason
// and increments the heat fallback count.

const proof = 'integration:check-runs-on-host-after-one-hot-sample';
const image = 'mainworks-trial:gy-3948-check';
const target = 'gy-compute@box';
let hosts: ShardHostsFixture;
let repository: { root: string; sha: string };
let port: number;
let ran: string;
const previousImage = process.env.GRAPHYARD_TRIAL_IMAGE;

before(async () => {
  hosts = await shardHosts('gy-3948-check-host', ['box'], { [image]: `sha256:${'3948'.repeat(16)}` });
  port = await freePort();
  ran = join(hosts.root, 'ran.jsonl');
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
  const local: string[][] = [];
  const started: unknown[] = [];
  let probeCall = 0;
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node') { local.push(args); return 'ok'; }
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
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
      heatRereadMs: 10,
      read: async (named, transport) => {
        const temp = sequence[Math.min(probeCall++, sequence.length - 1)]!;
        return (await readShardHosts(named, run, 2, transport)).map((reading, index) =>
          index === 0 ? reading : { ...reading, cores: 24, busy: 2, steal: 0, celsius: temp });
      },
    },
  });
  const lines = existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { cwd: string }) : [];
  return { result, lines, probeCall, started, localCheck: local.filter(args => args.includes('scripts/needs-postgres.mjs')) };
}

test(`${proof} — a host whose first probe is hot and second is cool runs the declared check there`, { timeout: 180_000 }, async () => {
  const { result, lines, probeCall, started, localCheck } = await runCheckWithTemperatures([88, 72]);
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(result.tests, { passed: 1, failed: [], files: 1 }, result.logTail);
  assert.equal(probeCall, 2, 'coordinator re-read the hot host once');
  assert.equal(lines.length, 1, result.logTail);
  assert.ok(lines[0]!.cwd.startsWith(join(hosts.home('box'), '.graphyard', 'runs', 'trial-')), `check ran on host: ${lines[0]!.cwd}`);
  assert.deepEqual(localCheck, [], 'check did not fall back to coordinator');
  assert.deepEqual(started, [], 'no local Compose services started');
  assert.equal(heatFallbacksInLastHour(readHeatFallbacks(repository.root)), 0);
});

test(`${proof} — a host hot on both probes falls back to coordinator naming both values and records a heat fallback`, { timeout: 180_000 }, async () => {
  const { result, probeCall, started, localCheck } = await runCheckWithTemperatures([95, 96]);
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(result.tests, { passed: 1, failed: [], files: 1 }, result.logTail);
  assert.equal(probeCall, 2);
  assert.equal(started.length, 1);
  assert.equal(localCheck.length, 1);
  assert.match(result.logTail, /too hot \(95°C, then 96°C; limit 85°C\)/);
  assert.equal(heatFallbacksInLastHour(readHeatFallbacks(repository.root)), 1);
});
