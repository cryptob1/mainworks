// Concern: disk headroom (GY-3122) — the close step measures the volumes Mainworks writes; below the
// floor it reclaims only its own leftovers, and while still below it no new merge trial or worker starts.
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../child-runner.js';
import type { MasterConfig } from '../master/profiles.js';
import { freeBytes } from '../master/worktrees.js';
import { trialContainerImage, trialImage } from '../merge-writer/trial-container.js';
import { repositoryTrialImageRepository } from '../merge-writer/repository-trial-image.js';
import { diskFloorBytes } from '../merge-writer/trial-load.js';
import { reclaimTrialCheckouts, trialCheckoutPrefix, trialCheckoutRoots, trialTemporaryPrefix, trialTemporaryRoots } from '../merge-writer/trial.js';
import { dockerBytes, pathsBytes, tallyLeftovers } from './leftovers.js';
import type { DaemonEffects } from './effects.js';
import { record, type DaemonAction, type DaemonState, type DiskKind, type DiskSample, type DiskUse } from './state.js';
import { workerVerificationPrefix, workerVerificationRoot, workerVerificationTimeoutMs } from '../merge-writer/worker-verification.js';
import { trialBuilder } from '../install/trial-image.js';
import { warmInUseDirectory } from '../merge-writer/remote-shards.js';
import { composeProjectPrefix, sweepComposePreviews } from '../compose-preview.js';
import { trialShareAllowance } from './cycle-merge-writer.js';
import { defaultMergeWriterParallel } from '../master/merge-writer-settings.js';

/** The cursor key of the shortage: a failed `attention` row the master is woken by while it stands. */
export const diskHeadroomKey = 'disk-headroom';
export const diskUseIntervalMs = 3_600_000;
export const diskUseMaxReadings = 48;
export interface Volume { path: string; freeBytes: number | null }

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const short = (volumes: Volume[], floor: number) => volumes.filter((volume): volume is Volume & { freeBytes: number } => volume.freeBytes !== null && volume.freeBytes < floor);
const mainworksImageRepo = (repository: string) => /^(mainworks|graphyard)-/.test(repository.split('/').at(-1) ?? repository);

/**
 * GY-3743: Mainworks's disk use by kind — Docker images grouped by repository (`mainworks-local`,
 * `mainworks-trial`, `graphyard-*`), Docker build cache, worktrees, trial runs and CLI releases —
 * sorted largest first, omitting empty or unreadable kinds.
 */
export async function measureDiskUseByKind(paths: { worktrees: string[]; trialRuns: string[]; cliReleases: string[] }, run: ChildRun): Promise<DiskKind[]> {
  const [worktrees, trialRuns, cliReleases, docker] = await Promise.all([
    pathsBytes(paths.worktrees),
    pathsBytes(paths.trialRuns),
    pathsBytes(paths.cliReleases),
    (async (): Promise<DiskKind[]> => {
      try {
        const df = JSON.parse(String(await run('docker', ['system', 'df', '-v', '--format', 'json'], { timeoutMs: 60_000 })));
        const repos = new Map<string, number>();
        for (const image of (df.Images ?? []) as { Repository?: string; Size?: string }[]) {
          const repo = image.Repository ?? '';
          if (!repo || !mainworksImageRepo(repo)) continue;
          repos.set(repo, (repos.get(repo) ?? 0) + dockerBytes(image.Size));
        }
        const buildCache = ((df.BuildCache ?? []) as { Size?: string }[]).reduce((total, row) => total + dockerBytes(row.Size), 0);
        return [...[...repos.entries()].map(([repo, bytes]) => ({ kind: `images: ${repo}`, bytes })), { kind: 'build cache', bytes: buildCache }];
      } catch { return []; }
    })(),
  ]);
  const kinds: DiskKind[] = [
    ...docker,
    ...(worktrees !== null ? [{ kind: 'worktrees', bytes: worktrees }] : []),
    ...(trialRuns !== null ? [{ kind: 'trial runs', bytes: trialRuns }] : []),
    ...(cliReleases !== null ? [{ kind: 'CLI releases', bytes: cliReleases }] : []),
  ];
  return kinds.filter(entry => entry.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

/** GY-3743: change in free bytes over the last 24 hours from stored hourly readings, or null with fewer than two. */
export function diskChange24h(readings: readonly DiskSample[]): number | null {
  if (readings.length < 2) return null;
  const latest = readings.at(-1)!, cutoff = Date.parse(latest.at) - 24 * diskUseIntervalMs;
  let baseline = readings[0]!, best = Math.abs(Date.parse(baseline.at) - cutoff);
  for (const sample of readings.slice(1, -1)) {
    const distance = Math.abs(Date.parse(sample.at) - cutoff);
    if (distance < best) { baseline = sample; best = distance; }
  }
  return latest.freeBytes - baseline.freeBytes;
}

/** GY-3743: `master status`'s `diskHeadroom` — free bytes, 24h change and the five largest kinds, plus shortage fields when below the floor. */
export function diskHeadroomSummary(shortage: DaemonState['diskHeadroom'], use: DiskUse | null) {
  if (!shortage && !use) return null;
  if (!use) return shortage;
  return {
    at: use.at,
    freeBytes: use.freeBytes,
    change24hBytes: diskChange24h(use.readings),
    top: use.top,
    ...(shortage ? { floorBytes: shortage.floorBytes, volumes: shortage.volumes, shortage: shortage.shortage } : {}),
  };
}

/**
 * One cycle's headroom check. Records free bytes and the five largest kinds of Mainworks disk use
 * at most once an hour (keeping the last 48 readings). Above the floor it holds nothing. Below it,
 * Mainworks's own leftovers are reclaimed and the volumes measured again; a shortage that remains
 * is kept on the cursor (`state.diskHeadroom`, which dispatch, the merge writer and master status
 * read) and as the failed `disk-headroom` attention row that wakes the master. The row names the
 * volumes and the floor, never the free bytes, so a shortage that only moves wakes the master once.
 */
export async function diskHeadroomStep(cycle: { config: Pick<MasterConfig, 'run'>; state: DaemonState; effects: DaemonEffects; now: () => number; performed: DaemonAction[] }) {
  const { config, state, effects, now, performed } = cycle;
  if (!effects.diskVolumes) return;
  const floor = diskFloorBytes(config);
  const volumes = await effects.diskVolumes();
  const clock = now();
  const measured = volumes.map(volume => volume.freeBytes).filter((value): value is number => value !== null);
  if (measured.length && (!state.diskUse || clock - Date.parse(state.diskUse.at) >= diskUseIntervalMs)) {
    const at = new Date(clock).toISOString();
    const freeBytes = Math.min(...measured);
    const kinds = effects.diskUseByKind ? await effects.diskUseByKind().catch(() => [] as DiskKind[]) : [];
    const top = kinds.filter(entry => entry.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 5);
    const readings = [...(state.diskUse?.readings ?? []), { at, freeBytes }].slice(-diskUseMaxReadings);
    state.diskUse = { at, freeBytes, readings, top };
  }
  let low = short(volumes, floor);
  if (!low.length && !state.diskHeadroom) return;
  if (low.length && effects.reclaimDisk) {
    const removed = await effects.reclaimDisk();
    tallyLeftovers(state, 'reclaimed', removed.length);
    if (removed.length) performed.push(await record(state, `disk-reclaim:${state.cycle}`, { kind: 'reclaim', work: null, principal: null, state: 'done', attempts: 1, cycle: state.cycle,
      detail: `Free space fell below the ${gb(floor)} floor; reclaimed Mainworks's own leftovers: ${removed.join(', ')}` }, now(), effects.persist));
    low = short(await effects.diskVolumes(), floor);
  }
  if (!low.length) {
    state.diskHeadroom = null;
    if (state.actions[diskHeadroomKey]?.state === 'failed') performed.push(await record(state, diskHeadroomKey, { kind: 'attention', work: null, principal: null, state: 'done', attempts: 1, cycle: state.cycle, detail: `Free space is back above the ${gb(floor)} floor; merge trials and workers start again` }, now(), effects.persist));
    return;
  }
  const at = new Date(now()).toISOString();
  state.diskHeadroom = { at, floorBytes: floor, volumes: low.map(volume => ({ path: volume.path, freeBytes: volume.freeBytes })),
    shortage: `${low.map(volume => `${volume.path} has ${gb(volume.freeBytes)} free`).join('; ')}, below the ${gb(floor)} floor after reclaiming Mainworks's own leftovers: no new merge trial or worker starts until space is freed` };
  const detail = `Disk headroom: ${low.map(volume => volume.path).join(', ')} below the ${gb(floor)} free-space floor after reclaiming Mainworks's own leftovers; no new merge trial or worker starts. Free space outside Mainworks (or raise the volume) — Mainworks never deletes what it did not create`;
  const standing = state.actions[diskHeadroomKey];
  if (standing?.state === 'failed' && standing.detail === detail) { standing.at = at; return; }
  performed.push(await record(state, diskHeadroomKey, { kind: 'attention', work: null, principal: null, state: 'failed', attempts: (standing?.attempts ?? 0) + 1, cycle: state.cycle, detail }, now(), effects.persist));
}

/** The durable volumes Mainworks writes: its checkout, data directory, worktree root, trial checkout root and durable temporary root — one path per device. A memory-backed /tmp is never measured: its size is not disk headroom. */
export async function mainworksVolumes(paths: string[]): Promise<Volume[]> {
  const seen = new Set<number>(), volumes: Volume[] = [];
  for (const path of paths) {
    const device = (await stat(path).catch(() => null))?.dev;
    if (device === undefined || seen.has(device)) continue;
    seen.add(device);
    volumes.push({ path, freeBytes: await freeBytes(path) });
  }
  return volumes;
}

/** The networks of trials' Compose projects (check services and E2E groups): `graphyard-preview-trial-…`. */
const trialNetworkPrefix = `${composeProjectPrefix}trial-`;

/**
 * GY-3188: what every ended job leaves, taken back by the loop's sweep: trial temporary, home and
 * checkout directories and worker verification allocations whose owner marker names a process
 * that is gone (a running one's are kept), stopped `mainworks-trial-` containers with their
 * anonymous volumes, preview and trial Compose projects whose owner is gone, trial networks no container uses, and Mainworks's own
 * trial-image build cache older than a day (its dedicated builder only). What was removed, by name.
 */
export async function reclaimJobLeftovers(run: ChildRun, roots: { temporary?: string[]; checkouts?: string[]; verification?: string[]; warmInUse?: string } = {}): Promise<string[]> {
  const removed: string[] = [];
  for (const root of roots.temporary ?? trialTemporaryRoots()) removed.push(...await reclaimTrialCheckouts(root, [trialTemporaryPrefix, 'gy-h']));
  for (const root of roots.checkouts ?? trialCheckoutRoots()) removed.push(...await reclaimTrialCheckouts(root, [trialCheckoutPrefix]));
  for (const root of roots.verification ?? [workerVerificationRoot()]) removed.push(...await reclaimTrialCheckouts(root, [workerVerificationPrefix]));
  const docker = async (args: string[]) => String(await run('docker', args, { timeoutMs: 60_000 })).split('\n').map(line => line.trim()).filter(Boolean);
  try {
    const containers = await docker(['ps', '--all', '--filter', 'name=^mainworks-trial-', '--filter', 'status=exited', '--filter', 'status=dead', '--format', '{{.Names}}']);
    for (const name of containers.filter(name => name.startsWith('mainworks-trial-'))) {
      try { await docker(['rm', '--volumes', name]); removed.push(`container ${name}`); } catch { /* the next */ }
    }
  } catch { /* no Docker on this host: nothing of Mainworks's there to reclaim */ }
  try { removed.push(...(await sweepComposePreviews({ docker: async (args, options) => String(await run('docker', args, options)) })).map(project => `compose project ${project}`)); } catch { /* the next sweep */ }
  // GY-3316: a trial network no container uses any more — its trial ended without removing it — is removed, so leaks never spend Docker's address pools.
  try {
    const names = (await docker(['network', 'ls', '--filter', `name=${trialNetworkPrefix}`, '--format', '{{.Name}}'])).filter(name => name.startsWith(trialNetworkPrefix));
    for (const line of names.length ? await docker(['network', 'inspect', '--format', '{{.Name}}\t{{len .Containers}}', ...names]) : []) {
      const [name = '', containers] = line.split('\t');
      if (containers !== '0' || !name.startsWith(trialNetworkPrefix)) continue;
      try { await docker(['network', 'rm', name]); removed.push(`network ${name}`); } catch { /* attached since, or already gone */ }
    }
  } catch { /* no Docker on this host */ }
  removed.push(...await pruneWarmImages(run, roots.warmInUse));
  try {
    const pruned = (await docker(['buildx', 'prune', '--builder', trialBuilder, '--filter', 'until=24h', '--force'])).find(line => /^Total:/i.test(line));
    if (pruned && !/:\s*0\s*B?$/i.test(pruned)) removed.push(`trial build cache older than a day (${pruned.replace(/^Total:\s*/i, '')})`);
  } catch { /* no trial builder on this host yet */ }
  return removed;
}

/**
 * GY-3745: the warm images remote shard hosts are sent, one per trial image digest and lockfile, are
 * removed except those for the current trial image's digest, the two newest and any a running trial uses
 * (never forced: Docker also keeps one a container uses). What was removed, by name.
 */
export async function pruneWarmImages(run: ChildRun, inUseDirectory = warmInUseDirectory()): Promise<string[]> {
  const inUse = new Set<string>();
  for (const name of await readdir(inUseDirectory).catch(() => [] as string[])) {
    const [tag, pid] = name.split('.');
    try { process.kill(Number(pid), 0); inUse.add(`graphyard-warm:${tag}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') inUse.add(`graphyard-warm:${tag}`); else await rm(join(inUseDirectory, name), { force: true }); }
  }
  const docker = async (args: string[]) => String(await run('docker', args, { timeoutMs: 60_000 })).split('\n').map(line => line.trim()).filter(Boolean);
  const removed: string[] = [];
  try {
    const digest = (await docker(['image', 'inspect', '--format', '{{.Id}}', trialImage()]).catch(() => []))[0]?.replace(/^sha256:/, '').slice(0, 12);
    const images = (await docker(['images', 'graphyard-warm', '--format', '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}']))
      .map(line => line.split('\t')).filter(([, image]) => image?.startsWith('graphyard-warm:') && !image.endsWith(':<none>'))
      .sort(([a = ''], [b = '']) => b.localeCompare(a)).map(([, image]) => image!);
    for (const image of images.slice(2)) {
      if ((digest && image.startsWith(`graphyard-warm:${digest}-`)) || inUse.has(image)) continue;
      try { await docker(['image', 'rm', image]); removed.push(`image ${image}`); } catch { /* in use, or already gone */ }
    }
  } catch { /* no Docker on this host */ }
  return removed;
}

/**
 * Below the disk floor: every job leftover, and `mainworks-trial` images other than the one trials
 * run (never forced, so Docker keeps an image a container still uses). Ended attempts' worktrees and
 * settled managed checkouts are already removed by the close step itself.
 */
export async function reclaimMainworksLeftovers(run: ChildRun, roots: { temporary?: string[]; checkouts?: string[]; verification?: string[] } = {}): Promise<string[]> {
  const removed = await reclaimJobLeftovers(run, roots);
  const docker = async (args: string[]) => String(await run('docker', args, { timeoutMs: 20_000 })).split('\n').map(line => line.trim()).filter(Boolean);
  try {
    // The image built here and the published one an install pulled (GY-3214) each have their own repository;
    // a repository's extended trial images (GY-3275) are cache, rebuilt from their Dockerfile's digest when
    // pruned, and so are the warm images remote shard hosts are sent (GY-3412), so below the floor every one not
    // in use goes (never forced: Docker keeps an image a container uses).
    const current = trialImage();
    for (const repository of new Set([trialContainerImage.split(':')[0]!, current.slice(0, current.lastIndexOf(':')), repositoryTrialImageRepository, 'graphyard-warm'])) {
      for (const image of await docker(['images', repository, '--format', '{{.Repository}}:{{.Tag}}'])) {
        if (image === current || !image.startsWith(`${repository}:`) || image.endsWith(':<none>')) continue;
        try { await docker(['image', 'rm', image]); removed.push(`image ${image}`); } catch { /* in use, or already gone */ }
      }
    }
  } catch { /* no Docker on this host */ }
  return removed;
}

/** Twice the longest deadline a trial container runs under: a merge trial at the most shares the host allows, or a worker verification (GY-3186). */
export const trialContainerMaxAgeMs = (run: Pick<MasterConfig, 'run'>['run']) =>
  2 * Math.max(trialShareAllowance(run.mergeWriter?.parallel ?? defaultMergeWriterParallel).timeoutMs, workerVerificationTimeoutMs);

/**
 * GY-3186: every cycle, stops (removes) a running `mainworks-trial-` container whose checkout (its working
 * directory) is gone or that has run past `maxAgeMs` — a trial nothing will end any more. What it stopped, by name.
 */
export async function stopOrphanTrialContainers(run: ChildRun, maxAgeMs: number, now = Date.now()): Promise<string[]> {
  const docker = async (args: string[]) => String(await run('docker', args, { timeoutMs: 20_000 })).split('\n').map(line => line.trim()).filter(Boolean);
  const stopped: string[] = [];
  try {
    const names = (await docker(['ps', '--filter', 'name=^mainworks-trial-', '--filter', 'status=running', '--format', '{{.Names}}'])).filter(name => name.startsWith('mainworks-trial-'));
    if (!names.length) return stopped;
    for (const line of await docker(['inspect', '--format', '{{.Name}}\t{{.State.StartedAt}}\t{{.Config.WorkingDir}}', ...names])) {
      const [name, startedAt, workdir] = line.replace(/^\//, '').split('\t');
      if (!name?.startsWith('mainworks-trial-') || (workdir && existsSync(workdir) && now - Date.parse(startedAt ?? '') <= maxAgeMs)) continue;
      try { await docker(['rm', '--force', '--volumes', name]); stopped.push(`container ${name}`); } catch { /* the next */ }
    }
  } catch { /* no Docker on this host: no trial container to stop */ }
  return stopped;
}
