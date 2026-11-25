import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import type { startCheckServices } from '../src/compose-preview.js';
import { readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { commitFile, dockerCalls, dockerCount, dockerCreates, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3825 AC-1 & AC-2: a declared preMerge check whose Compose file names an image built locally on
// the coordinator (never pushed) runs on a compute host: the image is sent once by image id before
// run-check, the service answers on the compute host, and an image that is neither local nor pullable
// fails the check with one line naming the image and the service.

const proof = 'integration:declared-check-runs-with-local-only-image';
const trialImage = 'mainworks-trial:local-only-check';
const privateImage = 'local-private-oracle:built-in-case';
const missingImage = 'local-private-oracle:missing-everywhere';
const target = 'gy-compute@box';

let hosts: ShardHostsFixture, repository: { root: string; sha: string }, port: number, ran: string;
const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
const freePort = () => new Promise<number>(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }); });
const accepts = () => new Promise<boolean>(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }).once('error', () => resolve(false)); });

before(async () => {
  hosts = await shardHosts('declared-check-local-image', ['box'], { [trialImage]: `sha256:${'3825'.repeat(16)}` });
  // The compute host cannot pull private images from any registry.
  mkdirSync(hosts.state('box'), { recursive: true });
  writeFileSync(join(hosts.state('box'), 'unpullable-images'), '*\n');
  // Build the private service image locally in the coordinator's Docker (never pushed).
  const context = await temporaryDirectory('private-image-context');
  await writeFile(join(context, 'Dockerfile'), 'FROM scratch\n');
  execFileSync(join(hosts.bin, 'docker'), ['build', '-t', privateImage, context], { encoding: 'utf8' });

  port = await freePort();
  ran = join(hosts.root, 'ran.jsonl');
  repository = await shardRepository('declared-check-local-image-repo', [], {
    'graphyard.json': JSON.stringify({
      delivery: {
        mergeGate: {
          perCandidate: [],
          preMerge: [{
            check: 'compare',
            command: 'node scripts/check-oracle.mjs',
            source: 'script',
            reason: 'fixture',
            services: [{ file: 'compose.json', service: 'oracle', port }],
          }],
        },
      },
    }),
    'compose.json': JSON.stringify({ services: { oracle: { image: privateImage, expose: [port] } } }),
    'scripts/check-oracle.mjs': `import { connect } from 'node:net';
import { appendFileSync } from 'node:fs';
const host = process.env.GRAPHYARD_SERVICE_ORACLE_HOST, port = Number(process.env.GRAPHYARD_SERVICE_ORACLE_PORT);
connect({ host, port }).once('connect', () => {
  appendFileSync(${JSON.stringify(ran)}, JSON.stringify({ cwd: process.cwd(), host, port }) + '\\n');
  console.log('oracle answered at ' + host + ':' + port);
  process.exit(0);
}).once('error', error => { console.error('no oracle: ' + error.message); process.exit(1); });
`,
  });
  process.env.GRAPHYARD_TRIAL_IMAGE = trialImage;
});

after(() => {
  if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE;
  else process.env.GRAPHYARD_TRIAL_IMAGE = previous;
});

async function trial(sha = repository.sha) {
  await rm(ran, { force: true });
  const local: string[][] = [], started: unknown[] = [];
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node') { local.push(args); return 'ok'; }
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const services: typeof startCheckServices = async request => { started.push(request); return { network: 'container:local-oracle', close: async () => {} }; };
  const result = await runTrial({
    root: repository.root,
    base: await temporaryDirectory('declared-check-local-base'),
    mergeSha: sha,
    changedFiles: ['scripts/check-oracle.mjs'],
    timeoutMs: 240_000,
    cores: 2,
    run,
    retries: 0,
    services,
    remote: { hosts: [target], read: async (named, transport) => (await readShardHosts(named, run, 2, transport)).map(reading => ({ ...reading, celsius: null })) },
  });
  const lines = existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { cwd: string; host: string; port: number }) : [];
  return { result, lines, started, localCheck: local.filter(args => args.includes('scripts/check-oracle.mjs')) };
}

const state = () => hosts.state('box');
const projects = () => JSON.parse(readFileSync(join(state(), 'state.json'), 'utf8')).projects ?? {};
const runs = () => readdirSync(join(hosts.home('box'), '.graphyard', 'runs'));

test(`${proof} — locally built service image is sent once to the compute host, service answers there, and second run skips transfer`, { timeout: 300_000 }, async () => {
  const first = await trial();
  assert.equal(first.result.build, 'pass', first.result.logTail);
  assert.deepEqual(first.result.tests, { passed: 1, failed: [], files: 1 }, first.result.logTail);
  assert.equal(first.lines.length, 1, first.result.logTail);
  assert.ok(first.lines[0]!.cwd.startsWith(join(hosts.home('box'), '.graphyard', 'runs', 'trial-')), `ran on host: ${first.lines[0]!.cwd}`);
  assert.deepEqual({ host: first.lines[0]!.host, port: first.lines[0]!.port }, { host: 'oracle', port });
  assert.deepEqual(first.localCheck, [], 'did not run on coordinator');
  assert.deepEqual(first.started, [], 'no services started on coordinator');
  assert.deepEqual(await dockerCreates(hosts.localState), [], 'no container started on coordinator');
  assert.deepEqual(projects(), {}, 'no Compose project left on host');
  assert.equal(await accepts(), false, 'service listener stopped');
  assert.deepEqual(runs(), [], 'run directory cleaned');
  assert.match(first.result.logTail, new RegExp(`oracle answered at oracle:${port}`));

  const loadsAfterFirst = dockerCount(state(), 'load');
  const savesAfterFirst = dockerCount(hosts.localState, 'save');
  assert.equal(loadsAfterFirst, 2, `warm + private image loaded once: ${dockerCalls(state()).join(', ')}`);

  // Second trial with the same local image id skips transferring the image.
  const second = await trial();
  assert.equal(second.result.build, 'pass', second.result.logTail);
  assert.deepEqual(second.result.tests, { passed: 1, failed: [], files: 1 }, second.result.logTail);
  assert.equal(dockerCount(state(), 'load'), loadsAfterFirst, 'second trial skips transfer when host has image id');
  assert.equal(dockerCount(hosts.localState, 'save'), savesAfterFirst, 'second trial skips docker save');
});

test(`${proof} — an image that is neither local nor pullable fails the check with one line naming the image and the service`, { timeout: 300_000 }, async () => {
  const missingSha = await commitFile(repository.root, 'compose.json', JSON.stringify({
    services: { oracle: { image: missingImage, expose: [port] } },
  }));
  const failed = await trial(missingSha);
  assert.deepEqual(failed.result.tests, { passed: 0, failed: ['compare'], files: 1 }, failed.result.logTail);
  assert.equal(failed.result.runnerExit, 1, failed.result.logTail);
  assert.deepEqual(failed.localCheck, [], 'missing image fails the check directly instead of falling back locally');
  assert.deepEqual(failed.started, [], 'no services started on coordinator');
  const matchingLines = failed.result.logTail.split('\n').filter(line => line.includes(missingImage) && line.includes('oracle'));
  assert.equal(matchingLines.length, 1, `expected one line naming image and service, got:\n${failed.result.logTail}`);
  assert.deepEqual(projects(), {}, 'no Compose project left on host');
  assert.deepEqual(runs(), [], 'run directory cleaned');
});
