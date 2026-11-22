import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import type { startCheckServices } from '../src/compose-preview.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCalls, dockerCreates, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3645: a repository whose merge gate is one script beside a Compose service could not use an added
// machine at all. A check with services and no selection now runs whole on a ready compute host: the
// commit goes there as a shard's does, the real graphyard-host-shim starts the commit's Compose
// services in the run directory, runs the command on their network and removes the project. Only
// Docker is a stand-in (helpers/shard-hosts.ts): its `compose up` starts a real TCP listener for the service.

const proof = 'integration:declared-check-runs-on-a-host';
const image = 'mainworks-trial:declared-check', target = 'gy-compute@box';
let hosts: ShardHostsFixture, repository: { root: string; sha: string }, port: number, ran: string, fails: string;
const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
const freePort = () => new Promise<number>(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }); });
const accepts = () => new Promise<boolean>(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }).once('error', () => resolve(false)); });

before(async () => {
  hosts = await shardHosts('declared-check-host', ['box'], { [image]: `sha256:${'3645'.repeat(16)}` });
  port = await freePort(); ran = join(hosts.root, 'ran.jsonl'); fails = join(hosts.root, 'fails');
  repository = await shardRepository('declared-check-repo', [], {
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'db', command: 'node scripts/needs-postgres.mjs', source: 'script', reason: 'fixture',
      services: [{ file: 'compose.json', service: 'postgres', port }] }] } } }),
    // A Compose file is YAML, and this JSON is YAML.
    'compose.json': JSON.stringify({ services: { postgres: { image: 'postgres:16', expose: [port] } } }),
    // The script needs its Postgres service: it connects where the service's variables point, and fails without an answer.
    'scripts/needs-postgres.mjs': `import { connect } from 'node:net';
import { appendFileSync, existsSync } from 'node:fs';
const host = process.env.GRAPHYARD_SERVICE_POSTGRES_HOST, port = Number(process.env.GRAPHYARD_SERVICE_POSTGRES_PORT);
connect({ host, port }).once('connect', () => {
  appendFileSync(${JSON.stringify(ran)}, JSON.stringify({ cwd: process.cwd(), host, port }) + '\\n');
  if (existsSync(${JSON.stringify(fails)})) { console.log('not ok 1 - the query returned no row'); process.exit(1); }
  console.log('postgres answered at ' + host + ':' + port); process.exit(0);
}).once('error', error => { console.error('no postgres: ' + error.message); process.exit(1); });
`,
  });
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});
after(() => { if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; });

/** One merge trial with the fake host added. Every `node` child this machine would run is recorded instead, as is every local services start. */
async function trial() {
  await rm(ran, { force: true });
  const local: string[][] = [], started: unknown[] = [], timings: string[] = [];
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node') { local.push(args); return 'ok'; }
    return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
  };
  const services: typeof startCheckServices = async request => { started.push(request); return { network: 'container:local-postgres', close: async () => {} }; };
  const result = await runTrial({ root: repository.root, base: await temporaryDirectory('declared-check-base'), mergeSha: repository.sha, changedFiles: ['scripts/needs-postgres.mjs'], timeoutMs: 240_000, cores: 2, run, retries: 0, services,
    onTiming: step => timings.push(step),
    remote: { hosts: [target], read: async (named, transport) => (await readShardHosts(named, run, 2, transport)).map(reading => ({ ...reading, celsius: null })) } });
  const lines = existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { cwd: string; host: string; port: number }) : [];
  return { result, lines, timings, started, localCheck: local.filter(args => args.includes('scripts/needs-postgres.mjs')) };
}
const state = () => hosts.state('box');
const projects = () => JSON.parse(readFileSync(join(state(), 'state.json'), 'utf8')).projects ?? {};
const runs = () => readdirSync(join(hosts.home('box'), '.graphyard', 'runs'));

test(`${proof} — the check's Postgres service starts on the host, the script passes there, nothing runs on this machine and no project is left behind`, { timeout: 300_000 }, async () => {
  const { result, lines, timings, started, localCheck } = await trial();
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(result.tests, { passed: 1, failed: [], files: 1 }, result.logTail);

  assert.deepEqual(dockerCalls(state()).filter(call => call.startsWith('compose')), ['compose up postgres', 'compose down'], 'the service started on the host and its project was removed');
  assert.equal(lines.length, 1, result.logTail);
  assert.ok(lines[0]!.cwd.startsWith(join(hosts.home('box'), '.graphyard', 'runs', 'trial-')), `the script ran in the host's run directory: ${lines[0]!.cwd}`);
  assert.deepEqual({ host: lines[0]!.host, port: lines[0]!.port }, { host: 'postgres', port }, 'with the service\'s variables');
  const [create] = await dockerCreates(state());
  assert.match(create!.join(' '), /--network=container:mainworks-check-\w+\.postgres /, 'on the services\' network');

  assert.deepEqual(localCheck, [], 'the script did not run on this machine');
  assert.deepEqual(started, [], 'and no services started here');
  assert.deepEqual(await dockerCreates(hosts.localState), [], 'nor any container');

  assert.deepEqual(projects(), {}, 'no Compose project is left on the host');
  assert.equal(await accepts(), false, 'the service is gone');
  assert.deepEqual(runs(), [], 'and the run directory is removed');

  for (const step of ['tests', 'services', 'command', 'teardown']) assert.ok(timings.includes(`${step}: db on ${target}`), `${step}: ${timings.join(', ')}`);
  assert.match(result.logTail, new RegExp(`\\[remote\\] check db ran on ${target}: services [\\d.]+s, command [\\d.]+s, teardown [\\d.]+s`), 'the trial records which host ran it, with each step\'s time');
  assert.match(result.logTail, new RegExp(`postgres answered at postgres:${port}`), 'and the script\'s output');
});

test(`${proof} — a script that fails on the host fails the check with its exit code and output, and the project is removed all the same`, { timeout: 300_000 }, async () => {
  await writeFile(fails, '');
  try {
    const calls = dockerCalls(state()).length;
    const { result, localCheck } = await trial();
    assert.deepEqual(result.tests, { passed: 0, failed: ['db'], files: 1 }, result.logTail);
    assert.equal(result.runnerExit, 1);
    assert.match(result.logTail, /not ok 1 - the query returned no row/);
    assert.deepEqual(localCheck, [], 'a failed check is the head\'s: it does not run again here');
    assert.deepEqual(dockerCalls(state()).slice(calls).filter(call => call.startsWith('compose')), ['compose up postgres', 'compose down']);
    assert.deepEqual(projects(), {});
    assert.equal(await accepts(), false);
  } finally { await rm(fails, { force: true }); }
});

test(`${proof} — with no host ready, or a host that drops the check, it runs on this machine as before and the reason is recorded`, { timeout: 300_000 }, async () => {
  await hosts.down('box', true);
  try {
    const away = await trial();
    assert.deepEqual(away.result.tests, { passed: 1, failed: [], files: 1 }, away.result.logTail);
    assert.equal(away.started.length, 1, 'the services start here');
    assert.equal(away.localCheck.length, 1, 'and the script runs here');
    assert.match(away.result.logTail, /\[remote\] check db runs on this machine: no host is ready \(gy-compute@box: .*unreachable/);
  } finally { await hosts.down('box', false); }

  await writeFile(join(state(), 'compose-up-fails'), '');
  try {
    const dropped = await trial();
    assert.deepEqual(dropped.result.tests, { passed: 1, failed: [], files: 1 }, dropped.result.logTail);
    assert.equal(dropped.localCheck.length, 1, 'the script runs here after the host dropped it');
    assert.match(dropped.result.logTail, /\[remote\] check db runs on this machine: host gy-compute@box dropped a shard: .*the services did not start/s);
    assert.deepEqual(projects(), {});
    assert.deepEqual(runs(), []);
  } finally { await rm(join(state(), 'compose-up-fails'), { force: true }); }
});
