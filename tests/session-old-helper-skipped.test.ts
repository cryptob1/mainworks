import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostAddCommand, readHostReadings, sessionCooldown } from '../src/hosts.js';
import { hostShimDigest, hostShimVerbs } from '../src/host-shim.js';
import { builderSessionCounts, remoteSessionHost, runRemoteSession } from '../src/remote-session.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { supervise } from '../src/session-watch.js';

// GY-4062: the incident of 2026-11-27 21:42Z. GY-4051 epochs 4 and 5 were placed on a test machine
// whose helper could not run them; each started, exited 1 with nothing written, and each attempt was
// spent. A host opened to sessions whose helper lacks run-session is skipped for sessions and
// status says why, while it stays ready for test shards. A session that fails before the agent wrote
// anything is a setup failure: the same attempt starts on this machine under its own supervisor and
// lease, and the host takes no session for 30 minutes. One that exits 0 finished, whatever it wrote.

const proof = 'integration:session-old-helper-skipped';
const older = 'gy-compute@older-helper', silent = 'gy-compute@silent-exit';
// The verbs of the helper probed on omarchypc that day: every trial verb, and no run-session.
const oldVerbs = 'probe:1 receive-pack:1 receive-image:1 prepare-run:1 run-shard:2 fetch-records:1 clean:1';
const probe = (shim: string, verbs: string) => ['shim ' + shim, 'verbs ' + verbs, 'user 1001 gy-compute', 'cores 32', 'load 1.00', 'temp-median 50', 'cpu 100 0 100 800 0 0 0 0 0 0', 'runs 0'].join('\n');
const reason = `${older}'s helper is older than this release and takes no sessions: run ${hostAddCommand(older)} first`;
const added = '2026-11-20T00:00:00.000Z';

/** Two hosts opened to three sessions each, the first one's helper lacking run-session, in a config home of their own. */
async function hosts() {
  const config = join(await temporaryDirectory('session-old-helper'), 'config');
  await mkdir(join(config, 'machine'), { recursive: true });
  const file = join(config, 'machine', 'hosts.json');
  await writeFile(file, JSON.stringify([{ target: older, sessions: 3, addedAt: added }, { target: silent, sessions: 3, addedAt: added }]));
  const run: ChildRun = async (command, args) => {
    if (command === 'sh') return probe(hostShimDigest, hostShimVerbs.join(' '));
    const target = args.find(arg => arg.startsWith('gy-compute@'));
    if (command === 'ssh' && target === older) return probe('1'.repeat(64), oldVerbs);
    if (command === 'ssh' && target === silent) return probe(hostShimDigest, hostShimVerbs.join(' '));
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  return { config, file, run };
}

test(`${proof} — a host whose helper lacks run-session is skipped with its reason in status, and stays ready for test shards`, async () => {
  const { file, run } = await hosts();
  for (const kind of ['claude', 'codex', 'opencode', 'cursor']) assert.equal(await remoteSessionHost(kind, () => [], run, file), silent, `a ${kind} builder never goes to ${older}`);
  assert.equal(await remoteSessionHost('codex', () => [silent, silent, silent], run, file), null, `with ${silent} full the builder runs on the coordinator, never on ${older}`);
  const readings = await readHostReadings([], { file, run, local: 'here' });
  const old = readings.find(host => host.host === older)!, good = readings.find(host => host.host === silent)!;
  assert.equal(old.away, false, `${older} keeps taking test shards`);
  assert.equal(old.takesNone, reason, 'status names why the host takes no builder');
  assert.equal(good.takesNone, undefined, 'a host whose helper runs sessions needs no reason');
  assert.deepEqual(builderSessionCounts([silent], [{ target: older, sessions: 3, takesNone: old.takesNone }, { target: silent, sessions: 3, takesNone: good.takesNone }]),
    { coordinator: 0, hosts: [{ host: older, running: 0, room: 3, takesNone: reason }, { host: silent, running: 1, room: 3 }] }, 'master status carries the reason beside the host');
});

/** A stand-in `ssh` whose run-session answers as the incident's host did: the agent starts, then the session exits `code` with nothing written. */
const silentSsh = (code: number) => `#!/bin/sh
for arg; do case "$arg" in -fNM|-O) exit 0;; esac; done
IFS= read -r request
IFS= read -r handover
printf '\\036mainworks-started {}\\n' >&2
exit ${code}
`;
const imageId = `sha256:${'ab'.repeat(32)}`;
/** The host's helper answers its probe and a session's preparation; only the run-session itself is the stand-in ssh on PATH. */
const silentRun = `async (command, args, options) => {
  if (command === 'docker') return args[0] === 'images' ? '' : '${imageId}';
  if (command === 'ssh' && args.at(-1) === 'probe') return ${JSON.stringify(probe(hostShimDigest, hostShimVerbs.join(' ')))};
  if (command === 'ssh' && args.at(-1)?.startsWith('prepare-run')) return 'run trial-silent';
  if (command === 'ssh') return '';
  return defaultChildRun(command, args, options);
}`;
const prepare: ChildRun = async (command, args, options) => {
  if (command === 'docker') return args[0] === 'images' ? '' : imageId;
  if (command === 'ssh' && args.at(-1) === 'probe') return probe(hostShimDigest, hostShimVerbs.join(' '));
  if (command === 'ssh' && args.at(-1)?.startsWith('prepare-run')) return 'run trial-silent';
  if (command === 'ssh') return '';
  return defaultChildRun(command, args, options);
};

async function silentHost(code = 1) {
  const directory = await temporaryDirectory('session-silent-exit');
  const { root } = await gitRepo({ root: join(directory, 'repo'), files: { 'base.txt': 'base' } });
  const file = join(directory, 'hosts.json'), bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(file, JSON.stringify([{ target: silent, sessions: 3, addedAt: added }]));
  await writeFile(join(bin, 'ssh'), silentSsh(code));
  await chmod(join(bin, 'ssh'), 0o755);
  return { directory, root, file, bin };
}

test(`${proof} — a session that fails before it writes anything starts the same attempt here and pauses the host for 30 minutes`, async () => {
  const { directory, root, file, bin } = await silentHost();
  const previous = process.env.PATH, localRan = join(directory, 'local-command');
  process.env.PATH = `${bin}:${previous}`;
  let local = false, printed = '';
  const sink = { write(text: string) { printed += text; return true; } } as NodeJS.WritableStream;
  try {
    const code = await runRemoteSession({ target: silent, worktree: root, homes: [], cli: join(directory, 'cli'), argv: [process.execPath, '-e', 'process.exit(0)'],
      localArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(localRan)}, 'local'); process.exit(0)`],
      env: {}, run: prepare, hostsFile: file, onLocal: () => { local = true; }, output: sink, errors: sink });
    assert.equal(code, 0, `a session that wrote nothing must not end the attempt: ${printed}`);
    assert.equal(local, true, 'the same attempt continues on this machine');
    assert.equal(await readFile(localRan, 'utf8'), 'local', 'the fallback is the launcher-supplied local command');
    assert.match(printed, /Sessions paused on gy-compute@silent-exit: the agent exited 1 before writing any output\. Starting this attempt on this machine\./);
    assert.match((await sessionCooldown(silent, file))?.reason ?? '', /exited 1 before writing any output/);
    assert.equal(await remoteSessionHost('codex', () => [], prepare, file), null, 'the next placement skips the paused host');
  } finally { process.env.PATH = previous; }
});

test(`${proof} — a session that exits 0 with nothing written finished: nothing starts here and the host is not paused`, async () => {
  const { directory, root, file, bin } = await silentHost(0);
  const previous = process.env.PATH, localRan = join(directory, 'local-command');
  process.env.PATH = `${bin}:${previous}`;
  let printed = '';
  const sink = { write(text: string) { printed += text; return true; } } as NodeJS.WritableStream;
  try {
    const code = await runRemoteSession({ target: silent, worktree: root, homes: [], cli: join(directory, 'cli'), argv: [process.execPath, '-e', 'process.exit(0)'],
      localArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(localRan)}, 'local'); process.exit(0)`],
      env: {}, run: prepare, hostsFile: file, output: sink, errors: sink });
    assert.equal(code, 0, printed);
    assert.equal(existsSync(localRan), false, 'a session that finished is not run again here');
    assert.equal(await sessionCooldown(silent, file), null, 'nor is its host paused');
    assert.equal(await remoteSessionHost('codex', () => [], prepare, file), silent, 'the host keeps taking sessions');
  } finally { process.env.PATH = previous; }
});

test(`${proof} — the supervisor keeps the claimed epoch and records no failed attempt while the fallback agent runs`, { timeout: 30_000 }, async () => {
  const store = await withDatabase('session-old-helper');
  await store.init();
  const { directory, root, file, bin } = await silentHost();
  const engine = new Engine(store, 120, 'owner/project');
  const operator = { id: 'operator', role: 'admin', sessionKind: 'human' } as const;
  const worker = { id: 'builder', role: 'worker', sessionKind: 'ai' } as const;
  let supervising: Promise<number> | undefined;
  let item;
  const surrendered: string[] = [];
  const previous = process.env.PATH;
  try {
    item = await engine.execute(operator, 'create', null, { title: 'Silent session falls back', type: 'chore', criteria: [{ id: 'AC-1', text: 'Starts elsewhere', proofs: [proof, 'e2e:verification-uses-remote-hosts'] }] }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
    const work = item.id, epoch = item.lease!.epoch;
    const started = join(directory, 'agent-started'), script = join(directory, 'session.mjs');
    const source = fileURLToPath(new URL('../src/remote-session.ts', import.meta.url));
    const runner = fileURLToPath(new URL('../src/child-runner.ts', import.meta.url));
    const input = { target: silent, worktree: root, homes: [], cli: join(directory, 'cli'), hostsFile: file, env: {},
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(started)}, '${epoch}'); setInterval(() => {}, 1000)`] };
    await writeFile(script, `import { runRemoteSession } from ${JSON.stringify(source)};
import { defaultChildRun } from ${JSON.stringify(runner)};
process.exitCode = await runRemoteSession({ ...${JSON.stringify(input)}, run: ${silentRun} });
`);
    process.env.PATH = `${bin}:${previous}`;
    supervising = supervise(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), script], epoch,
      async () => { const renewed = await engine.execute(worker, 'heartbeat', work, { epoch }, randomUUID()); return { lease: renewed.lease, updatedAt: renewed.updatedAt }; },
      { intervalMs: 100, graceMs: 50, log: join(directory, 'run.jsonl'), session: { surrender: async cause => {
        surrendered.push(cause);
        await engine.execute(worker, 'release', work, { epoch, cause }, randomUUID());
      } } });
    let ended = false;
    void supervising.then(() => { ended = true; });
    for (let tries = 0; tries < 200 && !existsSync(started) && !ended; tries++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(existsSync(started), true, 'the fallback agent starts before the supervisor ends its attempt');
    assert.equal(await readFile(started, 'utf8'), String(epoch));
    const current = (await store.list()).find(entry => entry.id === work)!;
    assert.equal(current.lease?.epoch, epoch);
    assert.equal(current.pipeline!.attempts.length, 1, 'no new attempt was claimed');
    assert.equal(current.pipeline!.attempts.filter(attempt => attempt.endedAt).length, 0, 'no attempt failed');
    assert.deepEqual(surrendered, [], 'the silent exit did not make the supervisor release the claim');
  } finally {
    process.env.PATH = previous;
    if (item?.lease) await engine.execute(worker, 'release', item.id, { epoch: item.lease.epoch }, randomUUID()).catch(() => {});
    await supervising;
    await store.close();
  }
});

test(`${proof} — master status names, beside the host the loop read, why it takes no builder`, async () => {
  const { config, file, run } = await hosts();
  const { root } = await gitRepo({ root: join(await temporaryDirectory('session-old-helper-status'), 'repo'), files: { 'base.txt': 'base' } });
  const master = { url: 'http://127.0.0.1:5', repository: 'owner/fixture', credentialFile: join(dirname(dirname(config)), 'coordinator.token'), hostId: 'yard-box', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const state = emptyDaemonState(master);
  state.hosts = await readHostReadings([], { file, run, local: 'here' });
  await writeDaemonState(master, state);
  const previous = process.env.MAINWORKS_CONFIG_HOME;
  process.env.MAINWORKS_CONFIG_HOME = config;
  try {
    const status = await masterStatusReport(root, master, async () => ({ work: [], now: new Date().toISOString() }), async () => '');
    assert.deepEqual(status.builderSessions, { coordinator: 0, hosts: [{ host: older, running: 0, room: 3, takesNone: reason }, { host: silent, running: 0, room: 3 }] });
  } finally { if (previous === undefined) delete process.env.MAINWORKS_CONFIG_HOME; else process.env.MAINWORKS_CONFIG_HOME = previous; }
});
