import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server } from 'node:net';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { connectionResetAttention, readRemoteShardRuns, readShardHosts, remoteShardSummary, shardSshSession } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { writeMachines } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCreates, shardHosts, shardRepository, sshdHost, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3534: a trial reaches each compute host over a few multiplexed SSH connections, not one per shard.
// The host is a real OpenSSH server whose only key runs graphyard-host-shim (restrict,command=…), behind
// a proxy that, like a host's sshd under a burst, resets every new connection above 5 open at once
// (kex_exchange_identification: read: Connection reset by peer). 30 shards placed on that host keep it
// ready over at most 3 new connections; a host that resets every connection reads away with one plain line.

const proof = 'integration:ssh-reuse-per-host';
const image = 'mainworks-trial:ssh-reuse';
const files = Array.from({ length: 30 }, (_, index) => `tests/plain-${index}.test.ts`);
let hosts: ShardHostsFixture, repository: { root: string; sha: string }, server: { kill(): void; start(): Promise<void> }, proxy: Server, target: string;
const previous = process.env.GRAPHYARD_TRIAL_IMAGE;
const counts = { opened: 0, open: 0, reset: 0 };
let limit = 5;

before(async () => {
  hosts = await shardHosts('ssh-reuse-per-host', ['compute'], { [image]: `sha256:${'3534'.repeat(16)}` });
  const sshd = await sshdHost(hosts.root, hosts.shim, hosts.home('compute'), join(hosts.root, 'hosts', 'compute', 'bin'), hosts.bin);
  server = sshd;
  target = `${sshd.user}@127.0.0.1`;
  proxy = createServer(socket => {
    counts.opened++;
    if (counts.open >= limit) { counts.reset++; socket.resetAndDestroy(); return; }
    counts.open++;
    const upstream = connect(sshd.port, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    const done = () => { socket.destroy(); upstream.destroy(); };
    socket.once('close', done); upstream.once('close', done); socket.on('error', done); upstream.on('error', done);
    socket.once('close', () => counts.open--);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  // The fixture's ssh reaches the proxy instead of the server.
  const wrapper = join(hosts.bin, 'ssh');
  const port = (proxy.address() as { port: number }).port;
  const text = execFileSync('cat', [wrapper], { encoding: 'utf8' }).replace(` -p ${sshd.port} `, ` -p ${port} `);
  await writeFile(wrapper, text); await chmod(wrapper, 0o755);
  repository = await shardRepository('ssh-reuse-per-host-repo', files);
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});
after(() => { server?.kill(); proxy?.close(); if (previous === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE; else process.env.GRAPHYARD_TRIAL_IMAGE = previous; });

const run: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
  const env = { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` };
  if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, env, wrapper: undefined });
  return defaultChildRun(command, args, { ...options, env });
};

/** A trial under its own verification slots directory, where the loop read the fixture host with 64 free cores. */
const ownSlots = async <T>(body: () => Promise<T>): Promise<T> => {
  // GY-3755: the machine running this test may set its own slots directory, whose loop readings omit the fixture host and so give it no room.
  const directory = await temporaryDirectory('ssh-reuse-per-host-slots'), previous = process.env.MAINWORKS_VERIFICATION_SLOTS_DIR;
  writeMachines(directory, [{ name: 'local', local: true, away: false, cores: 2, busy: 0, celsius: null }, { name: target, away: false, cores: 64, busy: 0, celsius: null }]);
  process.env.MAINWORKS_VERIFICATION_SLOTS_DIR = directory;
  try { return await body(); } finally { if (previous === undefined) delete process.env.MAINWORKS_VERIFICATION_SLOTS_DIR; else process.env.MAINWORKS_VERIFICATION_SLOTS_DIR = previous; }
};

/** One trial of 30 one-file shards; this machine reads too hot to take any while the host runs, so all 30 are placed on the host at once. */
const trial = async () => ownSlots(async () => runTrial({ root: repository.root, base: await temporaryDirectory('ssh-reuse-per-host-base'), mergeSha: repository.sha, changedFiles: files, timeoutMs: 300_000, cores: 2, run, retries: 0, groupSize: 1,
  remote: { hosts: [target], read: async (named, transport) => (await readShardHosts(named, run, 2, transport)).map((reading, index) => index === 0
    ? { ...reading, celsius: 999 } : { ...reading, cores: reading.away ? 0 : 64, busy: 0, steal: 0, celsius: null }) } }));

test(`${proof} — 30 shards placed on one host open at most 3 new SSH connections to it, run through the shim, and the host stays ready under a server that resets above 5`, { timeout: 600_000 }, async () => {
  Object.assign(counts, { opened: 0, reset: 0 }); limit = 5;
  const result = await trial();
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed }, { passed: files.length, failed: [] }, result.logTail);
  const host = remoteShardSummary(readRemoteShardRuns(repository.root))!.hosts.find(entry => entry.name === target)!;
  assert.equal(host.state, 'ready', host.reason);
  assert.equal(counts.reset, 0, 'the server reset no connection');
  assert.ok(counts.opened <= 3, `at most 3 new SSH connections for the trial, opened ${counts.opened}`);
  assert.equal((await dockerCreates(hosts.state('compute'))).length, files.length, 'every shard ran on the host');
  assert.deepEqual(connectionResetAttention(readRemoteShardRuns(repository.root)), []);

  // A session over the multiplexed connection still reaches only the shim's allow-list.
  const transport = shardSshSession(run);
  try {
    const refused = await transport.session(target, words => Promise.resolve(run('ssh', [...words, 'echo mainworks-plain-shell'])).then(out => ({ out: String(out), ok: true }), (error: unknown) => ({ out: String((error as { stderr?: unknown }).stderr ?? error), ok: false })));
    assert.equal(refused.ok, false, refused.out);
    assert.doesNotMatch(refused.out, /^mainworks-plain-shell$/m);
  } finally { await transport.close(); }
});

test(`${proof} — a host that resets every connection reads away, and master status says so in one plain line with the next step`, { timeout: 600_000 }, async () => {
  Object.assign(counts, { opened: 0, reset: 0 }); limit = 0;
  try {
    const result = await trial();
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed }, { passed: files.length, failed: [] }, result.logTail);
  } finally { limit = 5; }
  const runs = readRemoteShardRuns(repository.root);
  const host = remoteShardSummary(runs)!.hosts.find(entry => entry.name === target)!;
  assert.equal(host.state, 'away');
  assert.match(host.reason ?? '', /reset/i, 'the record keeps the SSH text in its details');
  const attention = connectionResetAttention(runs);
  assert.equal(attention.length, 1, JSON.stringify(attention));
  assert.equal(attention[0]!.text.split('\n').length, 1);
  assert.match(attention[0]!.text, new RegExp(`^${target.replace(/\./g, '\\.')} takes no trial shards: it reset the SSH connection`));
  assert.doesNotMatch(`${attention[0]!.text} ${attention[0]!.next}`, /kex_exchange_identification|by peer|ssh:/);
  assert.ok(attention[0]!.next.length > 0);
});

test('unit:ssh-reuse-per-host-pinned — the 30 shards still run on the host when the machine running the test sets a slots directory whose readings omit it', { timeout: 600_000 }, async () => {
  const loop = await temporaryDirectory('ssh-reuse-per-host-loop-slots'), names = ['MAINWORKS_VERIFICATION_SLOTS_DIR', 'GRAPHYARD_VERIFICATION_SLOTS_DIR'] as const;
  const previous = names.map(name => process.env[name]);
  writeMachines(loop, [{ name: 'local', local: true, away: false, cores: 2, busy: 0, celsius: null }]);
  for (const name of names) process.env[name] = loop;
  Object.assign(counts, { opened: 0, reset: 0 }); limit = 5;
  const before = (await dockerCreates(hosts.state('compute'))).length;
  try {
    const result = await trial();
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual({ passed: result.tests.passed, failed: result.tests.failed }, { passed: files.length, failed: [] }, result.logTail);
  } finally { names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); }
  assert.equal((await dockerCreates(hosts.state('compute'))).length - before, files.length, 'every shard ran on the host');
});

test('unit:ssh-reuse-per-host-pinned — a session sshd refuses while it still holds one the transport released retries its own connection, never opening a new one', { timeout: 600_000 }, async () => {
  // GY-3824: sshd frees a session after the client's slot is released; a session refused in that gap made ssh connect directly.
  const config = join(hosts.root, 'sshd', 'sshd_config'), text = await readFile(config, 'utf8');
  const restart = async (body: string) => { server.kill(); await writeFile(config, body); await server.start(); };
  await restart(`${text}MaxSessions 1\n`);
  Object.assign(counts, { opened: 0, reset: 0 }); limit = 5;
  const transport = shardSshSession(run);
  try {
    // The race's one condition, injected: sshd still holds the only session slot, which the transport has released.
    const held = await transport.session(target, words => new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
      const child = spawn(join(hosts.bin, 'ssh'), ['-v', ...words, `update-shim ${'0'.repeat(64)}`], { stdio: ['pipe', 'ignore', 'pipe'] });
      let said = '';
      child.stderr.on('data', chunk => { said += String(chunk); if (/master session id/.test(said)) resolve(child); });
      child.once('exit', () => reject(new Error(said)));
    }));
    let refusals = 0;
    const probe = await transport.session(target, words => Promise.resolve(run('ssh', [...words, 'probe'])).catch((error: unknown) => { refusals++; held.stdin!.end(); throw error; }));
    assert.match(String(probe), /^verbs /m);
    assert.ok(refusals > 0, 'sshd refused the session over the shared connection');
    assert.equal(counts.opened, 1, 'the refused session opened no new SSH connection');
  } finally { await transport.close(); await restart(text); }
});
