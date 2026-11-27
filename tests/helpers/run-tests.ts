import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, shardFiles } from '../../scripts/ci-tests.mjs';
import { hostAccountsVariable } from '../../src/host-accounts.js';
import { isolatedTestEnvironment, reserveTestPorts, sharedClusterPort, suiteRunEnvironment, testPortSpan, type ReserveOptions } from '../../src/cli/test-isolation.js';
import { hostMemoryFloor, memoryRecoveryMarginBytes, readHostMemory } from '../../src/master/host-memory.js';
import { bytesPerSuiteFile, declareSlotFiles, heldVariable, othersDeclaredFiles, readStrictCap, sessionVerificationSlot, slotsDirectoryVariable } from '../../src/master/verification-slots.js';
import { readTempOwner, tempOwnerGone, tempOwnerMarker, writeTempOwner } from '../../src/tmp-reclaim.js';
import { stopServersUnder } from '../../src/postgres-stop.js';
import { buildEntries, builtEntries, builtEntry } from '../../bin/built-entry.mjs';
import { ensureDashboardBuilt } from '../../src/dashboard-build.js';

export { ensureDashboardBuilt };

// The suite's own runner (GY-174): `npm test` and `npm run test:browser` start here, so a clean run
// needs nothing the session has to know about the host.
//
//   node --import tsx tests/helpers/run-tests.ts [FILE...]            the Node suite (default tests/*.test.ts)
//   node --import tsx tests/helpers/run-tests.ts --browser [ARGS...]  the Playwright suite
//   node --import tsx tests/helpers/run-tests.ts --typecheck          tsc --noEmit (npm run typecheck)
//
// Started from a Mainworks session, a whole suite first takes a host verification slot
// (src/master/verification-slots.ts, GY-612), waiting while every slot on the host is held; a type
// check and a run of selected files take none (GY-3447). The
// Node suite then runs at the breadth the host's memory affords (GY-1821): the files in flight
// stay inside what is available beyond the floor and the deferral margin, less what runs on the
// other slots declared — a suite alone runs at node's full breadth, and however many suites the
// slots admit together, they cannot take the host under its memory floor.
//
// Three runner options select and measure the Node suite's files (GY-499), as CI's shard jobs do:
//   --files-from LIST   run the files LIST names, one per line (an empty list runs nothing)
//   --shard I/N         run only shard I of N, balanced by file count, in the shard's own order
//                       (tests/helpers/ordered-tests.mjs)
//   --durations FILE    also write each file's wall time to FILE (tests/helpers/file-durations.mjs)
//   --file-timeout MS   kill a file's process group after MS, reporting a named test failure
//
// A run of named files (no --files-from, no --shard) is a targeted re-run, so it carries the merge
// trial's per-file bound unless the caller names its own.
//
// Every GRAPHYARD_* and HERDR_* variable the caller carries is withheld from the tests except the
// harness controls in src/cli/test-isolation.ts; GRAPHYARD_TEST_PORT is a window of free ports this
// run holds until it exits, and GRAPHYARD_BROWSER_PORT the dev server's port. Two runs on one host —
// two worktrees, or a worker beside a producer — therefore never share a database or a server.
//
// Before and after the suite it runs, the runner removes the `<tmpdir>/mainworks-*` directories
// whose owner marker names a process that is gone (GY-421), so a killed run stops leaking its
// embedded-Postgres data dirs; one a live run owns, or one with no marker, is never touched.

/** A run's scratch root (GY-3691): `gy` and mkdtemp's six characters, short so socket paths under it stay inside the 107-byte bound. */
const runScratchName = /^gy[A-Za-z0-9]{6}$/;

/** One runner sweep over `tmpRoot` (the host's tmpdir by default): its `mainworks-*` leftovers whose owner is gone. */
export async function sweepLeftoverTempDirectories(tmpRoot = tmpdir()) {
  const removed: string[] = [];
  for (const name of await readdir(tmpRoot).catch(() => [] as string[])) {
    const directory = join(tmpRoot, name), owner = (name.startsWith('graphyard-') || runScratchName.test(name)) && !name.endsWith('.owner') ? await readTempOwner(directory) : null;
    if (!owner || !tempOwnerGone(owner) || !stopServersUnder(directory)) continue;
    try { await rm(directory, { recursive: true, force: true }); await rm(tempOwnerMarker(directory), { force: true }); removed.push(directory); } catch { /* the next sweep */ }
  }
  return removed;
}

/** statfs's type for a memory-backed filesystem (TMPFS_MAGIC). */
const tmpfsType = 0x01021994;
/**
 * The tmpdir the suite runs under when the caller's is a tmpfs (GY-2001), else null. Mainworks
 * refuses a managed checkout on a tmpfs, so every test that makes one under the tmpdir failed on a
 * host whose /tmp is memory-backed, the merge writer's trials included; CI's /tmp is on disk. The
 * replacement is short (socket paths built under it have a length bound), on disk, outside any
 * checkout, so no fixture finds a repository or an install above it, and sticky and shared (1777)
 * as /tmp is, which tests/runner-executor.test.ts requires of the fixture root.
 */
export function durableTestTmpdir(current = tmpdir(), home = homedir(), statfs: (path: string) => { type: number } = statfsSync, besideCheckout = dirname(fileURLToPath(new URL('../..', import.meta.url)))): string | null {
  const memoryBacked = (path: string) => { try { return statfs(path).type === tmpfsType; } catch { return false; } };
  if (!memoryBacked(current)) return null;
  // GY-2001's replacement assumes the home is on disk. A remote shard's container is the one place
  // it is not: the host shim runs it with HOME=/tmp, itself a tmpfs (src/host-shim.ts), so the suite
  // takes the one durable writable place it holds — the run allocation beside this checkout, which
  // the shim cloned into `<run>/repo` — and keeps a fresh sticky tmp under it.
  const directory = memoryBacked(home) ? join(besideCheckout, 'tmp') : join(home, '.gy', 'tmp');
  try { mkdirSync(directory, { recursive: true }); chmodSync(directory, 0o1777); } catch { return null; }
  return memoryBacked(directory) ? null : directory;
}

/** The browser suite's historical port, tried first. */
export const defaultBrowserPort = 4319;

/**
 * Admission still budgets Node processes and test workloads, even with one shared Postgres.
 * How many suite files a run starts at once (GY-1821). The base runner left this to node --test's
 * default, one file per CPU, whatever the host held: on the 24-CPU host whose dips GY-1821 files,
 * one full suite swung available memory from 27.4 GB to 9.4 GB (about `bytesPerSuiteFile` a file),
 * and the second suite the slots bound still admitted took the host under the floor the loop
 * defers launches at and files memory-pressure faults on. The breadth is what the host's memory
 * affords beyond its floor and the deferral's own recovery margin, less the files runs on slots
 * already held declared, never fewer than two and never above node's own default — so a run alone
 * runs at full speed, and however many suites the slots admit together, their files stay inside
 * the budget. `budgetBytes` is the caller's reading minus the floor minus the margin.
 */
export function suiteBreadth({ budgetBytes, otherFiles, cpus, perFileBytes = bytesPerSuiteFile }: { budgetBytes: number; otherFiles: number; cpus: number; perFileBytes?: number }): number {
  const affordable = Math.floor(budgetBytes / perFileBytes) - Math.max(0, otherFiles);
  return Math.max(2, Math.min(affordable, Math.max(2, cpus - 1)));
}

/**
 * GY-3401: a Mainworks session's run never goes past the session's share of the host's test
 * parallelism (VITEST_MAX_WORKERS, set at its launch from the cores and the sessions running), so
 * sessions already running stop fanning one file out per core on a hot host.
 */
export function sessionSuiteBreadth(host: number | null, environment: NodeJS.ProcessEnv = process.env): number | null {
  const budget = Number(environment.VITEST_MAX_WORKERS);
  return Number.isInteger(budget) && budget >= 1 ? Math.min(host ?? budget, budget) : host;
}

/** GY-3610: the most files a run on the coordinator starts at once, whatever its cores and memory. */
export const coordinatorTestBreadth = 4;
/**
 * GY-3610: whether this run is on a machine that runs the master loop (the loop joined the host's
 * heavy-job budget, which every session it starts carries) and is not a trial shard (no list, no
 * shard). Such a run starts at most `coordinatorTestBreadth` files at once and none while the CPU is hot.
 */
export const coordinatorRun = (environment: NodeJS.ProcessEnv, args: string[]) => {
  const { filesFrom, shard } = runnerOptions(args);
  return !!environment[slotsDirectoryVariable] && !filesFrom && !shard;
};

/** The breadth this run starts at, or null when nothing judges it: a run inside a run, a host whose memory cannot be read (CI keeps node's own default). */
export async function hostSuiteBreadth(environment: NodeJS.ProcessEnv = process.env, memory: typeof readHostMemory = readHostMemory, pid: number = process.pid, cpus = availableParallelism(), args: string[] = []): Promise<number | null> {
  if (environment[heldVariable]) return null;
  const cap = coordinatorRun(environment, args) ? coordinatorTestBreadth : Infinity;
  const reading = await memory();
  if (!reading) return Number.isFinite(cap) ? cap : null;
  const directory = environment[slotsDirectoryVariable];
  const otherFiles = directory ? await othersDeclaredFiles(directory, pid) : 0;
  const budgetBytes = reading.availableBytes - hostMemoryFloor(reading.totalBytes) - memoryRecoveryMarginBytes;
  return Math.min(cap, suiteBreadth({ budgetBytes, otherFiles, cpus }));
}

export interface RunOptions {
  cwd?: string;
  /** Test files or extra `node --test` arguments; the default is every tests/*.test.ts under `cwd`. */
  args?: string[];
  browser?: boolean;
  environment?: NodeJS.ProcessEnv;
  ports?: ReserveOptions;
  stdio?: 'inherit' | 'pipe';
  /** How many files to run at once (GY-1821): passed to `node --test` as its own flag when the run is not a shard. Absent: node's default. */
  breadth?: number;
  /** GY-3610: hold each new file while the CPU sensors under this hwmon directory read at the heat limit (a coordinator run; never a shard). */
  holdWhenHot?: string;
  /** GY-3691: where the run's scratch root is made; the tmpdir by default (a session's `.graphyard/scratch`). */
  scratch?: string;
}
export interface RunResult { code: number; base: number; environment: Record<string, string>; stdout: string; stderr: string }

/** The runner's own options, taken out of the arguments `node --test` receives. */
function runnerOptions(args: string[]) {
  const rest: string[] = [], options: { filesFrom?: string; shard?: string; durations?: string; fileTimeout?: string } = {};
  const flags = { '--files-from': 'filesFrom', '--shard': 'shard', '--durations': 'durations', '--file-timeout': 'fileTimeout' } as const;
  for (let at = 0; at < args.length; at++) {
    const [flag, inline] = args[at].split(/=(.*)/s, 2) as [string, string | undefined];
    const key = flags[flag as keyof typeof flags];
    if (!key) { rest.push(args[at]); continue; }
    const value = inline ?? args[++at];
    if (!value) throw new Error(`${flag} needs a value`);
    options[key] = value;
  }
  return { rest, ...options };
}

/**
 * The `node --test` arguments for these runner arguments: the files named, else every
 * tests/*.test.ts, narrowed to one shard. Without --files-from or --shard every argument passes
 * through in its order, as before those options existed.
 */
/** The merge trial's per-file bound (src/merge-writer/trial.ts): a targeted re-run of named files carries it. */
export const trialFileTimeoutMs = 300_000;

export function nodeTestArgs(cwd: string, args: string[], perFile = false) {
  const { rest, filesFrom, shard, durations, fileTimeout: given } = runnerOptions(args);
  // A run of named files is a targeted re-run — complete's pre-submit rerun of the trial's failing
  // files (complete.ts: "the rerun runs under the trial's own bound"), `npm run test:affected --
  // FILE...` — so it runs under the merge trial's per-file bound: what passes it passes the trial's
  // shape, and a file that bound cannot host (the slow-tick receipt's twenty-run execution)
  // defers to an unbounded run there as it does in the trial. A whole-suite run names no file and
  // stays unbounded.
  const fileTimeout = given ?? (!filesFrom && !shard && rest.some(argument => !argument.startsWith('-')) ? String(trialFileTimeoutMs) : undefined);
  if (fileTimeout && (!Number.isFinite(Number(fileTimeout)) || Number(fileTimeout) <= 0)) throw new Error('--file-timeout needs positive milliseconds');
  // GY-3610: a run that holds files on heat starts each file itself (bounded-tests.mjs), bounded or not.
  const perFileRun = !!fileTimeout || perFile && !filesFrom && !shard, bounded = perFileRun ? { bounded: true } : {};
  const reporters = perFileRun
    ? [...(fileTimeout ? [`--file-timeout=${fileTimeout}`] : []), ...(durations ? ['--durations', resolve(cwd, durations)] : [])]
    : durations ? ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${fileURLToPath(new URL('./file-durations.mjs', import.meta.url))}`, `--test-reporter-destination=${resolve(cwd, durations)}`] : [];
  const all = () => readdirSync(resolve(cwd, 'tests')).filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
  if (!filesFrom && !shard) return { ...bounded, args: [...reporters, ...rest, ...(rest.some(arg => !arg.startsWith('-')) ? [] : all())], empty: false, ordered: false };
  const listed = filesFrom ? readFileSync(resolve(cwd, filesFrom), 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
  const named = [...rest.filter(arg => !arg.startsWith('-')), ...listed];
  let files = named.length || filesFrom ? named : all();
  const flags = rest.filter(arg => arg.startsWith('-'));
  if (shard) {
    const { index, count } = parseShard(shard); files = shardFiles(files, count)[index - 1];
    // A shard runs through ordered-tests.mjs, which starts its files in the order given, unless the
    // caller passes `node --test` flags of its own.
    if (!flags.length && !fileTimeout) return { args: [...(durations ? ['--durations', resolve(cwd, durations)] : []), ...files], empty: !files.length, ordered: true };
  }
  return { ...bounded, args: [...reporters, ...flags, ...files], empty: !files.length, ordered: false };
}

/** A nested runner starts beyond its parent's reserved window. */
export const nestedPortGap = testPortSpan;

export function nestedFirst(environment: NodeJS.ProcessEnv = process.env): { first?: number } {
  const parent = Number(environment.GRAPHYARD_TEST_PORT);
  return Number.isInteger(parent) && parent > 0 ? { first: parent + nestedPortGap } : {};
}

/** Whether a selected test file drives a browser or runs E2E cases against the served dashboard. */
export const opensDashboard = (cwd: string, args: string[]) => args.filter(arg => /\.test\.[cm]?[jt]sx?$/.test(arg)).some(file => {
  try { return /chromium|playwright|projectCaseSuite|runCases/.test(readFileSync(resolve(cwd, file), 'utf8')); } catch { return false; }
});
export async function runTests(options: RunOptions = {}): Promise<RunResult> {
  const tmpRoot = durableTestTmpdir() ?? undefined;
  await sweepLeftoverTempDirectories(tmpRoot);
  await sweepLeftoverTempDirectories(dirname(tmpRoot ?? tmpdir()));
  const cwd = resolve(options.cwd ?? process.cwd()), args = options.args ?? [];
  const selection = options.browser ? null : nodeTestArgs(cwd, args, !!options.holdWhenHot);
  // An empty selection (a shard with nothing assigned, a change that affects no test) runs nothing:
  // `node --test` with no files would run every file it discovers instead.
  if (selection?.empty) {
    if (options.stdio !== 'pipe') console.log('No test files selected for this run.');
    return { code: 0, base: 0, environment: {}, stdout: '', stderr: '' };
  }
  // The browser window is the dev server's port with a spare beside it, then one window above both
  // the run's shared Postgres cluster and the sentinel that holds the window (GY-3356); a Node
  // run's window is its shared cluster's own.
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  // A remote shard's fresh checkout has no built dashboard either: a selected file that opens it in a browser would find no sign-in page.
  if (resolve(cwd) === resolve(repository) && !existsSync(join(cwd, 'dist', 'index.html')) && opensDashboard(cwd, selection?.args ?? [])) await ensureDashboardBuilt(cwd);
  // GY-3611: the CLI and server the tests start run from dist/; build them once, before the first file, when missing or stale.
  if (resolve(cwd) === resolve(repository) && !builtEntries.every(name => builtEntry(cwd, name))) await buildEntries(cwd);
  // GY-3691: everything the run writes to its tmpdir — its Postgres, every test's directories — goes
  // under one scratch root, removed when the run ends, pass, fail or SIGTERM, unless
  // GRAPHYARD_KEEP_SCRATCH is set. A killed runner leaves its owner marker, so the next sweep takes it.
  const keepScratch = !!(options.environment ?? process.env).GRAPHYARD_KEEP_SCRATCH;
  // It sits beside the caller's tmpdir when that parent is writable, else inside it: a socket path
  // under it is then no longer than under the tmpdir itself (the 107-byte bound a trial's
  // `~/.gy/tmp/gy-XXXXXXX` left no room under), and a session's `/tmp` gives `/tmp/gyXXXXXX`.
  const base = tmpRoot ?? tmpdir();
  const scratch = options.scratch ? await mkdtemp(join(options.scratch, 'gy')) : await mkdtemp(join(dirname(base), 'gy')).catch(() => mkdtemp(join(base, 'gy')));
  await writeTempOwner(scratch);
  const reservation = await reserveTestPorts(options.browser ? { first: defaultBrowserPort, span: 2 + testPortSpan, last: 65_000, ...options.ports } : { ...nestedFirst(), ...options.ports });
  let postgres: Awaited<ReturnType<typeof import('./postgres.js').startPostgres>> | undefined;
  try {
    // One shared warm cluster for the whole run, whichever suite runs (GY-3356). A nested browser
    // run whose caller already passed GRAPHYARD_TEST_DATABASE_URL reuses that cluster (GY-3818).
    const existingClusterUrl = options.environment?.GRAPHYARD_TEST_DATABASE_URL;
    const clusterPort = sharedClusterPort(reservation.base, options.browser);
    let clusterUrl = existingClusterUrl;
    if (!clusterUrl) {
      const { startPostgres } = await import('./postgres.js');
      postgres = await startPostgres(clusterPort, undefined, scratch);
      clusterUrl = postgres.url;
    }
    // The suite's managed checkouts live inside the tree it runs from (ignored by .graphyard/): a worker's
    // sandbox can write nowhere else, and the default ~/.local/share/graphyard failed every checkout there (GY-498).
    // A run of the suite reads no host memory (GY-612): a host the suite itself loaded low must not
    // flip the behaviour of tests that stub no reading.
    const dataHome = resolve(cwd, '.graphyard/test-data');
    mkdirSync(dataHome, { recursive: true });
    // GY-3290: a suite run is one heavy job of the host budget (the slot the runner itself takes
    // when a session started it). Its tests run outside any budget unless a fixture joins one — a
    // loop or deploy watch started by a test joins the budget under this run's data directory —
    // and that budget is wide, so one file's fixtures never starve another's past the per-file
    // bound. tests/host-heavy-budget.test.ts drives the real limit in its own directories.
    mkdirSync(join(dataHome, 'heavy-jobs'), { recursive: true });
    try { writeFileSync(join(dataHome, 'heavy-jobs', 'limit'), '64\n'); } catch { /* the default bound stands */ }
    const set = { ...suiteRunEnvironment({ browser: options.browser, browserPort: reservation.base, clusterPort, clusterUrl, dataHome, tmpRoot: scratch }),
      // GY-3333: the suite's host-level account records live under the test data home, never the real ~/.gy.
      [hostAccountsVariable]: join(dataHome, 'host-accounts'),
      // GY-3753: each browser run builds and serves its own bundle, removed with its scratch root.
      ...(options.browser ? { GRAPHYARD_BROWSER_DIST: options.environment?.GRAPHYARD_BROWSER_DIST ?? join(scratch, 'browser-dist') } : {}),
      ...(options.environment?.GRAPHYARD_PLAYWRIGHT_NO_WEBSERVER ? { GRAPHYARD_PLAYWRIGHT_NO_WEBSERVER: options.environment.GRAPHYARD_PLAYWRIGHT_NO_WEBSERVER } : {}) };
    const environment = isolatedTestEnvironment(options.environment ?? process.env, set);
    const [command, commandArgs] = options.browser || !selection
      ? [process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', ...args]]
      : [process.execPath, ['--import', import.meta.resolve('tsx'), ...(selection.bounded ? [fileURLToPath(new URL('./bounded-tests.mjs', import.meta.url))] : selection.ordered ? [fileURLToPath(new URL('./ordered-tests.mjs', import.meta.url))] : ['--test']),
        // The breadth the host's memory affords (GY-1821). A caller's own flag stands; a shard's
        // order is ordered-tests.mjs's own concurrency, which stays node's default as CI has it.
        ...(selection.ordered || options.breadth === undefined || !Number.isFinite(options.breadth) || options.breadth < 1 || runnerOptions(args).rest.some(argument => argument.startsWith('--test-concurrency')) ? [] : [`--test-concurrency=${Math.floor(options.breadth)}`]),
        ...(selection.bounded && options.holdWhenHot ? [`--hold-when-hot=${options.holdWhenHot}`] : []),
        ...selection.args]];
    // Core dumps off for the run and every Postgres it starts (GY-3112): a crash costs no disk.
    const child = spawn('/bin/sh', ['-c', 'ulimit -c 0 && exec "$@"', 'sh', command, ...commandArgs], { cwd, env: environment, stdio: options.stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward); process.on('SIGTERM', forward);
    const code = await new Promise<number>(done => child.on('close', (status, signal) => done(status ?? (signal ? 1 : 0))));
    process.off('SIGINT', forward); process.off('SIGTERM', forward);
    // Whatever this run's children leaked — a failure before an after hook, a killed file — its
    // processes are gone now, so the sweep takes their directories back at once.
    await sweepLeftoverTempDirectories(tmpRoot);
    return { code, base: reservation.base, environment, stdout, stderr };
  } finally {
    try { await postgres?.stop(); } finally {
      reservation.release();
      if (keepScratch) console.error(`GRAPHYARD_KEEP_SCRATCH: kept ${scratch}`);
      else { stopServersUnder(scratch); await rm(scratch, { recursive: true, force: true, maxRetries: 5 }); }
      await rm(tempOwnerMarker(scratch), { force: true });
    }
  }
}

/**
 * GY-3447: the host heavy-job slot a session's run takes, named, or null. Only a whole suite (no
 * file, list or shard selecting part of it) is a heavy job; a type check (`npm run build`) and
 * selected files start at once, under the session's share of the host's test parallelism — except under a
 * host strict cap (GY-3446), when a selected run takes a slot too.
 */
export const heavyRunLabel = (mode: 'test' | 'browser' | 'typecheck', args: string[], strict = false) =>
  mode === 'typecheck' || args.length && !strict ? null : `${mode === 'browser' ? 'npm run test:browser' : 'npm test'}${args.length ? ` ${args.join(' ')}` : ''}`;

/**
 * `tsc --noEmit` under the caller's environment, marked as holding the slot this process took. The check
 * needs ~1.5 GB of heap; in a trial container Node's default heap stops at half its ~2.6 GB memory (GY-3627).
 */
export async function typecheck(cwd = process.cwd(), args: string[] = []) {
  const child = spawn(process.execPath, ['--max-old-space-size=2048', fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '--noEmit', ...args], { cwd, stdio: 'inherit', env: { ...process.env, [heldVariable]: '1' } });
  return await new Promise<number>(done => child.on('close', (status, signal) => done(status ?? (signal ? 1 : 0))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `npm test -- browser-tests/` (complete's re-run of a failed trial's browser suite) runs the Playwright suite.
  const browserPaths = process.argv.length > 2 && process.argv.slice(2).every(arg => arg.startsWith('browser-tests'));
  const mode = process.argv[2] === '--browser' || browserPaths ? 'browser' : process.argv[2] === '--typecheck' ? 'typecheck' : 'test';
  const args = process.argv.slice(mode === 'test' || browserPaths ? 2 : 3);
  const directory = process.env[slotsDirectoryVariable], label = heavyRunLabel(mode, args, !!directory && !!readStrictCap(directory)), held = label ? await sessionVerificationSlot(label) : null;
  // The breadth the host affords is computed with the slot already held, so a run that starts later
  // sees this one's declaration; it is declared back onto the slot for the runs after it (GY-1821).
  const breadth = mode === 'test' ? sessionSuiteBreadth(await hostSuiteBreadth(process.env, readHostMemory, process.pid, availableParallelism(), args)) : null;
  if (held && breadth !== null) declareSlotFiles(held, breadth);
  const holdWhenHot = mode === 'test' && coordinatorRun(process.env, args) ? '/sys/class/hwmon' : undefined;
  try { process.exitCode = mode === 'typecheck' ? await typecheck(process.cwd(), args) : (await runTests({ browser: mode === 'browser', args, breadth: breadth ?? undefined, holdWhenHot })).code; }
  finally { held?.release(); }
}
