import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../../src/child-runner.js';
import { readShardHosts, realFreeCores, remoteShardSession, runShardsOnHosts, shardHosts, shardSshSession, splitLocalOnlyTests, underHeatLimit, type HostReading, type PlacedHost, type ShardSshSession } from '../../src/merge-writer/remote-shards.js';
import { trialImage } from '../../src/merge-writer/trial-container.js';

// GY-3610: what `npm run test:affected` runs its selected files with. Workers' own test runs were the
// largest CPU load on the coordinator, so with a compute host ready (`graphyard host add`, answering
// and under its heat limit) the files go there through the merge trial's remote-shard runner — the
// checkout as it stands, committed or not, one shard per ready host. Files naming a local-only word
// (remote-shards.ts), and a shard every host turned away, run here; with no host ready everything
// does, under run-tests.ts's narrow, heat-aware breadth on a coordinator.

/** The suite runner, here and on a host. */
export const suiteCommand = ['node', '--import', 'tsx', 'tests/helpers/run-tests.ts'];
/** How many files a remote shard runs at once, as a trial shard does on its host. */
const remoteBreadth = 4;

/** The working tree as a commit (tracked and untracked, ignored files left out), on HEAD, touching no ref or index. */
async function snapshot(root: string, run: ChildRun) {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-affected-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') };
    const git = async (...args: string[]) => String(await run('git', ['-C', root, ...args], { env })).trim();
    await git('read-tree', 'HEAD'); await git('add', '-A');
    return await git('-c', 'user.name=graphyard', '-c', 'user.email=graphyard@localhost', 'commit-tree', await git('write-tree'), '-p', 'HEAD', '-m', 'test:affected snapshot');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Run `files` here through the suite runner, printing as it goes; its exit code. */
export function runHere(root: string, files: readonly string[], command: readonly string[] = suiteCommand, print: (text: string) => void = text => process.stdout.write(text)) {
  if (!files.length) return Promise.resolve(0);
  const child = spawn(command[0]!, [...command.slice(1), ...files], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => print(String(chunk))); child.stderr.on('data', chunk => print(String(chunk)));
  return new Promise<number>(done => child.on('close', status => done(status ?? 1)));
}

export interface ComputeRunOptions { root: string; files: readonly string[]; run?: ChildRun; hosts?: readonly string[]; command?: readonly string[]; image?: string; print?: (text: string) => void; read?: (hosts: readonly string[], transport: ShardSshSession) => Promise<HostReading[]> }

/** Run `files` on the ready compute hosts, local-only files here; the run's exit code, or null when no host is ready (run them all here). */
export async function runOnComputeHosts(input: ComputeRunOptions): Promise<number | null> {
  const run = input.run ?? defaultChildRun, command = input.command ?? suiteCommand, print = input.print ?? (text => process.stdout.write(text));
  const hosts = input.hosts ?? await shardHosts();
  if (!hosts.length || !input.files.length) return null;
  const transport = shardSshSession(run);
  try {
    const readings = (await (input.read ?? ((named, shared) => readShardHosts(named, run, availableParallelism(), shared)))(hosts, transport)).slice(1);
    const ready = hosts.map((name, index) => ({ name, remote: name, reading: readings[index]!, room: 1 })).filter(host => underHeatLimit(host.reading) && realFreeCores(host.reading) >= 1);
    if (!ready.length) return null;
    const split = await splitLocalOnlyTests(input.files, file => readFile(join(input.root, file), 'utf8'));
    const shards = ready.map((_, index) => split.remoteable.filter((__, at) => at % ready.length === index)).filter(group => group.length);
    print(`test:affected: ${split.remoteable.length} file(s) on ${ready.map(host => host.name).join(', ')}${split.localOnly.length ? `, ${split.localOnly.length} local-only here` : ''}\n`);
    const session = shards.length ? remoteShardSession({ root: input.root, sha: await snapshot(input.root, run), image: input.image ?? trialImage(), run, deadline: Date.now() + 60 * 60_000, transport }) : null;
    let failed = false;
    const done = new Set<number>();
    const local = runHere(input.root, split.localOnly, command, print);
    try {
      // This machine takes no remote file (room 0): a shard every host turned away runs here after.
      const here: PlacedHost<string> = { name: 'here', room: 0, reading: { name: 'here', cores: 0, busy: 0, steal: 0, celsius: null, limit: Infinity, away: false } };
      const placement = await runShardsOnHosts({ count: shards.length, hosts: [here, ...ready], breadth: remoteBreadth, run: async (host, index) => {
        const ended = await session!.run(host.remote!, index, shards[index]!, (list, records) => [...command, '--files-from', list, '--durations', records, `--test-concurrency=${remoteBreadth}`, '--file-timeout=300000'], remoteBreadth);
        print(`$ [${host.name}] shard ${index + 1}\n${ended.out}`);
        if (!ended.ok) failed = true;
        done.add(index);
      } });
      const left = shards.filter((_, index) => !done.has(index)).flat();
      if (placement.dropped.length) print(`test:affected: ${placement.dropped.join(', ')} turned its shard away${left.length ? `; ${left.length} file(s) run here` : ''}\n`);
      if (left.length && await runHere(input.root, left, command, print) !== 0) failed = true;
    } finally { await session?.close(); }
    return (await local) !== 0 || failed ? 1 : 0;
  } finally { await transport.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd(), files = process.argv.slice(2);
  process.exitCode = await runOnComputeHosts({ root, files }) ?? await runHere(root, files, suiteCommand);
}
