import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { masterSessionConfinement, sessionConfinement, type MasterConfinementProbe } from '../src/master/launch.js';
import { sessionMountNamespaceWorks } from '../src/master/confinement.js';
import { heavyDrainFile, hostHeavyJobsDirectory, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';

// GY-3445: since GY-3290 the drain lives in the host-wide heavy-jobs folder, which the master
// session mounted read-only, so `master drain` failed with EROFS. The master session's confinement
// now grants the folder writable; a worker session, granted the folder to take slots, still only
// reads the drain record.

const checkout = join(import.meta.dirname, '..');

async function coordinator(base: string) {
  const root = join(base, 'coordinator');
  await gitRepo({ root, message: 'coordinator', files: {} });
  writeFileSync(join(root, '.gitignore'), '.graphyard/\n');
  return root;
}

// The `master drain` / `master resume` subcommands, run the way the CLI dispatches them.
function masterCommandScript(base: string) {
  const script = join(base, 'master-command.mts');
  writeFileSync(script, `const { operationsCommand } = await import(${JSON.stringify(pathToFileURL(join(checkout, 'src', 'cli', 'master', 'operations.ts')).href)});
const [id, ...args] = process.argv.slice(2);
await operationsCommand({ id, args, print: (value) => console.log(JSON.stringify(value)), master: { masterAgentName: 'graphyard-master-project' }, coordinator: null });
`);
  return script;
}

// GY-3622: the batch gate's check on this file failed whenever it ran where the suite's temporary
// directory lies under /tmp — a remote shard's container, a session's scratch, a host whose /tmp is
// on disk — because every confinement replaces /tmp with the session's own scratch, so the
// master-command script the test tells the session to run was not there to resolve and node
// answered ERR_MODULE_NOT_FOUND. The base directory is granted to every master session the file
// builds, so the script stays visible wherever the suite put it.
const masterSession = (root: string, base: string, probe: MasterConfinementProbe = {}) => masterSessionConfinement('claude', root, probe, [base]);

test('unit:master-drain-writable-pinned — a confined master session resolves the command script it is told to run even when the fixture lies under /tmp', async () => {
  // The fault's own condition: the fixture under /tmp, as the suite's temporary directory is on a
  // remote shard's container. No bubblewrap is run here — the assertion is about the mounts.
  const base = await temporaryDirectory('master-drain-pin', '/tmp');
  const root = join(base, 'coordinator');
  mkdirSync(root, { recursive: true });
  const script = masterCommandScript(base);
  const { wrapper } = await masterSession(root, base, { mountNamespaceWorks: true });
  // The scratch bound over /tmp (and /var/tmp) shadows whatever the host put there, and the
  // read-only root bind comes before it, so only a bind of base after that shadow leaves the
  // script resolvable at the path the test passes the session.
  const shadows = wrapper.reduce<number[]>((found, word, at) => word === '--bind' && (wrapper[at + 2] === '/tmp' || wrapper[at + 2] === '/var/tmp') ? [...found, at] : found, []);
  const covering = shadows.filter(at => script.startsWith(`${wrapper[at + 2]}/`)).at(-1) ?? -1;
  assert.ok(covering >= 0, 'the namespace replaces /tmp with its own scratch, hiding the fixture');
  const grant = wrapper.findIndex((word, at) => at > covering && word === '--bind' && wrapper[at + 1] === base && wrapper[at + 2] === base);
  assert.ok(grant > covering, `the session is granted ${base} after the scratch that would otherwise hide ${script}`);
});

test('integration:master-drain-writable — a confined master session runs master drain and master resume against the host-wide heavy-jobs folder, and a worker session still cannot write the drain record', { timeout: 120_000 }, async () => {
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');
  const base = await temporaryDirectory('master-drain');
  const root = await coordinator(base);
  const saved = { data: process.env.GRAPHYARD_DATA_HOME, slots: process.env[slotsDirectoryVariable] };
  process.env.GRAPHYARD_DATA_HOME = join(base, 'data');
  delete process.env[slotsDirectoryVariable];
  try {
    const heavyJobs = hostHeavyJobsDirectory(), record = heavyDrainFile(heavyJobs), script = masterCommandScript(base);
    const master = await masterSession(root, base);
    const inMaster = (...args: string[]) => spawnSync(master.wrapper[0], [...master.wrapper.slice(1), process.execPath, '--import', 'tsx', script, ...args], { cwd: checkout, encoding: 'utf8' });

    const drained = inMaster('drain', 'huck verification window, 30 minutes');
    assert.equal(drained.status, 0, drained.stderr);
    assert.equal(JSON.parse(drained.stdout).drained, true);
    assert.ok(existsSync(record), 'the drain record is written host-wide, outside the session');

    // A worker session takes slots in the same folder, but its drain folder is read-only.
    mkdirSync(join(base, 'worktree'), { recursive: true });
    const worker = await sessionConfinement('claude', [], { directory: join(base, 'worktree'), environment: { [slotsDirectoryVariable]: heavyJobs } }, root);
    const inWorker = (script: string) => spawnSync(worker!.wrapper[0], [...worker!.wrapper.slice(1), 'bash', '-c', script], { cwd: join(base, 'worktree'), encoding: 'utf8' });
    assert.equal(inWorker(`mkdir ${join(heavyJobs, 'slot-1')} && rmdir ${join(heavyJobs, 'slot-1')}`).status, 0, 'the worker still takes a slot');
    assert.equal(inWorker(`cat ${record}`).status, 0, 'the worker reads the drain');
    for (const write of [`rm -f ${record}`, `echo '{"reason":"forged"}' > ${record}`, `echo x > ${record}.new`])
      assert.notEqual(inWorker(write).status, 0, `the worker cannot run: ${write}`);
    assert.match(JSON.stringify(JSON.parse(execFileSync('cat', [record], { encoding: 'utf8' }))), /huck verification window/);

    const resumed = inMaster('resume');
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).resumed, true);
    assert.ok(!existsSync(record), 'master resume removes the drain record');
  } finally {
    if (saved.data === undefined) delete process.env.GRAPHYARD_DATA_HOME; else process.env.GRAPHYARD_DATA_HOME = saved.data;
    if (saved.slots === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = saved.slots;
  }
});

test('e2e:master-drain-from-session — master drain from one install\'s confined master session is recorded host-wide, another install\'s session sees it, and master resume lifts it', { timeout: 120_000 }, async () => {
  assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this host');
  const base = await temporaryDirectory('master-drain-host');
  const saved = { data: process.env.GRAPHYARD_DATA_HOME, slots: process.env[slotsDirectoryVariable] };
  process.env.GRAPHYARD_DATA_HOME = join(base, 'data');
  delete process.env[slotsDirectoryVariable];
  try {
    const record = heavyDrainFile(hostHeavyJobsDirectory()), script = masterCommandScript(base);
    // Two installs on one host: each its own checkout and confined master session, one data home.
    const [core, huck] = await Promise.all(['core', 'huck'].map(async name => masterSession(await coordinator(join(base, name)), base)));
    const inside = (session: typeof core, ...args: string[]) => spawnSync(session.wrapper[0], [...session.wrapper.slice(1), ...args], { cwd: checkout, encoding: 'utf8' });
    const drained = inside(core!, process.execPath, '--import', 'tsx', script, 'drain', 'huck UAT window');
    assert.equal(drained.status, 0, drained.stderr);
    const seen = inside(huck!, 'cat', record);
    assert.equal(seen.status, 0, seen.stderr);
    assert.equal(JSON.parse(seen.stdout).reason, 'huck UAT window', 'the other install sees the drain');
    const resumed = inside(core!, process.execPath, '--import', 'tsx', script, 'resume');
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).resumed, true);
    assert.notEqual(inside(huck!, 'test', '-e', record).status, 0, 'the drain is lifted for every install');
  } finally {
    if (saved.data === undefined) delete process.env.GRAPHYARD_DATA_HOME; else process.env.GRAPHYARD_DATA_HOME = saved.data;
    if (saved.slots === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = saved.slots;
  }
});
