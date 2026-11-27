import { appOnboarding, type AppOnboarding } from './model/onboarding-work.js';
// The continuous deploy builds, restarts and checks health before publishing the ready CLI.
// Failed builds leave the healthy pairing alone; failed restarts use schema-aware rollback.
// The master loop restarts onto the serving tip recorded here (daemon/run.ts restartCause).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { imageLock, takeLock, withHostLock } from './host-lock.js';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { GitRunner } from './merge-writer/local-observation.js';
import { serveRecordPath, readServeRecord, type ServeCheck } from './serve-app.js';
import { servedVerified } from './batch-gate.js';
import { mainworksRepository } from './scenarios.js';
import { servedCommit } from './production-watch.js';
import type { Work } from './model/work.js';
import { stateDirectory } from './install/layout.js';

/**
 * What the deploy last served, the tip that failed and is retried after a backoff (GY-3703), and,
 * while a rollback has not yet succeeded, the tip still to restore (tip is then null: nothing is served).
 * `repository` names the repository the watch serves — its origin's owner/name — so a record for one
 * repository cannot pass for another's release health; records written before it was kept (or by a
 * checkout whose origin names no repository) name none (GY-2955).
 */
export interface DeployRecord { tip: string | null; failed: string | null; reason: string | null; at: string; restore?: string | null; attempts?: number; /** Retries the failed tip has had (GY-3703). */ retries?: number; repository?: string | null; /** This successful deploy selected a batch-gate verified tip. */ verified?: boolean }
export interface DeployHistoryEntry { commit: string; at: string; repository?: string | null }
export const deployRecordPath = (root: string) => join(stateDirectory(root), 'deploy.json');
const deployHistoryPath = (root: string) => join(stateDirectory(root), 'deploy-history.jsonl');
export function readDeployRecord(file: string): DeployRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as DeployRecord; } catch { return null; }
}
async function writeDeployRecord(file: string, record: Omit<DeployRecord, 'at'>) {
  const at = new Date().toISOString();
  const history = join(dirname(file), 'deploy-history.jsonl');
  await mkdir(dirname(file), { recursive: true });
  // Preserve the last healthy deploy's timestamp before a later write rewrites deploy.json.
  if (!existsSync(history)) {
    const previous = readDeployRecord(file);
    if (previous?.tip && !previous.failed && !previous.restore) {
      await appendFile(history, `${JSON.stringify({ commit: previous.tip, at: previous.at, repository: previous.repository ?? null })}\n`).catch(() => {});
    }
  }
  await writeFile(`${file}.tmp`, `${JSON.stringify({ ...record, reason: record.reason?.slice(0, 2000) ?? null, at }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  // GY-3725: keep a history of serving deploys so flow numbers measure each merge to the first deploy that contains it.
  if (record.tip && !record.failed && !record.restore) {
    await appendFile(history, `${JSON.stringify({ commit: record.tip, at, repository: record.repository ?? null })}\n`).catch(() => {});
  }
}

/**
 * Serving deploy records for `root` (and `repository`, when named), oldest first, deduplicated to
 * each commit's earliest serving time (GY-3725). Reads `deploy-history.jsonl` and `serve-history.jsonl`
 * plus the current `deploy.json` and `served.json` so installs with no history file yet still measure.
 */
export function readDeployHistory(root: string, repository?: string | null): DeployHistoryEntry[] {
  const entries: DeployHistoryEntry[] = [];
  const isTime = (at: unknown): at is string => typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) && Number.isFinite(Date.parse(at));
  const matchesRepo = (repo: string | null | undefined) => !repository || repo?.toLowerCase() === repository.toLowerCase();
  const readLines = (file: string, checkRepo: boolean) => {
    if (!existsSync(file)) return;
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Partial<DeployHistoryEntry>;
          if (typeof parsed.commit === 'string' && /^[0-9a-f]{40}$/i.test(parsed.commit) && isTime(parsed.at)) {
            if (!checkRepo || matchesRepo(parsed.repository)) entries.push({ commit: parsed.commit.toLowerCase(), at: parsed.at, repository: parsed.repository ?? null });
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* unreadable */ }
  };
  readLines(deployHistoryPath(root), true);
  readLines(join(stateDirectory(root), 'serve-history.jsonl'), false);
  const current = readDeployRecord(deployRecordPath(root));
  if (current?.tip && /^[0-9a-f]{40}$/i.test(current.tip) && isTime(current.at) && matchesRepo(current.repository)) {
    entries.push({ commit: current.tip.toLowerCase(), at: current.at, repository: current.repository ?? null });
  }
  const serve = readServeRecord(serveRecordPath(root));
  if (serve?.commit && /^[0-9a-f]{40}$/i.test(serve.commit) && isTime(serve.at)) {
    entries.push({ commit: serve.commit.toLowerCase(), at: serve.at });
  }
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const seen = new Set<string>();
  return entries.filter(entry => seen.has(entry.commit) ? false : (seen.add(entry.commit), true));
}

/**
 * The control plane's own update record (GY-3199), beside the deploy record but never standing in
 * for it: the Mainworks commit this install's server, loop and CLI run, when the watch last
 * checked for a verified commit, when it last moved the control plane, and the step of the last
 * failed upgrade. The deploy record stays the managed repository's serving and rollback state;
 * this is the control plane's update clock, which master status and the daily diagnostics read.
 */
export interface ControlPlaneRecord {
  /** The Mainworks commit the control plane runs; null before the first pass learned one. */
  commit: string | null;
  /** When the watch last completed a check for a verified commit. */
  checkedAt: string | null;
  /** When the control plane last moved to a new Mainworks commit. */
  updatedAt: string | null;
  /** The latest verified commit the check has seen, and when this install first saw it: the ref carries no publication time, so the first sighting is the staleness clock. */
  verified: string | null;
  verifiedSeenAt: string | null;
  /** The step of the last failed control-plane upgrade, why it failed, and when; null after a passing one. */
  failedStep: string | null;
  failedReason: string | null;
  failedAt: string | null;
  /** GY-3746: the newer build an install following Mainworks waits to take, why, and since when; null once it updates. */
  waiting?: { tip: string; reason: string; since: string } | null;
  /** GY-4030: the retry the last successful update needed, named; null when it needed none. */
  retried?: string | null;
  at: string;
}
export const controlPlaneRecordPath = (root: string) => join(stateDirectory(root), 'control-plane.json');
export function readControlPlaneRecord(file: string): ControlPlaneRecord | null {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as ControlPlaneRecord; } catch { return null; }
}
export async function writeControlPlaneRecord(file: string, record: Omit<Partial<ControlPlaneRecord>, 'at'>) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

/** The longest wait before a failed verified commit is tried again (GY-3199). */
export const controlPlaneRetryMs = 60 * 60_000;
/** GY-3703: waits before each retry of a failed verified commit; the last repeats. */
const deployRetryBackoffMs = [5 * 60_000, 15 * 60_000, 30 * 60_000, controlPlaneRetryMs];
/** How old a check, or a first sighting of an unrun verified commit, may be before the daily diagnostics reports it (GY-3199). */
const controlPlaneStaleAfterMs = 24 * 60 * 60_000;

/** The control plane's staleness, as the daily diagnostics reports it: a check over a day old, or a verified commit first seen over a day ago that the install still does not run. */
export function controlPlaneStaleLines(record: ControlPlaneRecord | null, now: number): string[] {
  if (!record) return [];
  const age = (at: string) => {
    const ms = now - Date.parse(at);
    return Number.isFinite(ms) ? ms : null;
  };
  const checked = record.checkedAt ? age(record.checkedAt) : null;
  const seen = record.verifiedSeenAt ? age(record.verifiedSeenAt) : null;
  return [
    ...(checked !== null && checked > controlPlaneStaleAfterMs ? [`the last check for a verified Mainworks commit is ${Math.round(checked / 3_600_000)} hours old (over 24 hours)`] : []),
    ...(record.verified && record.commit !== record.verified && seen !== null && seen > controlPlaneStaleAfterMs
      ? [`the control plane still runs ${record.commit?.slice(0, 12) ?? 'no recorded commit'} while the verified commit ${record.verified.slice(0, 12)} was first seen ${Math.round(seen / 3_600_000)} hours ago (over 24 hours)`]
      : []),
  ];
}

/** What master status shows of the control plane's own update record (GY-3199), with the staleness the daily diagnostics reports. */
export function controlPlaneSummary(record: ControlPlaneRecord | null, now: number) {
  if (!record) return null;
  const short = (sha: string | null) => sha ? sha.slice(0, 12) : null;
  return { commit: short(record.commit), checkedAt: record.checkedAt, updatedAt: record.updatedAt,
    verified: short(record.verified), verifiedSeenAt: record.verifiedSeenAt,
    failedStep: record.failedStep, failedReason: record.failedReason,
    waiting: record.waiting?.reason ?? null, retried: record.retried ?? null,
    stale: controlPlaneStaleLines(record, now) };
}

/** GY-3864: one attention line when the control plane's last update failed, naming the failed step and the build. */
export function controlPlaneUpdateAttention(record: Pick<ControlPlaneRecord, 'commit' | 'verified' | 'failedStep' | 'failedReason'> | null) {
  if (!record?.failedStep) return [];
  const build = record.verified ? record.verified.slice(0, 12) : 'the new build';
  const running = record.commit ? `, still running ${record.commit.slice(0, 12)}` : '';
  const reason = record.failedReason ? `: ${record.failedReason.split('\n')[0]!.slice(0, 200)}` : '';
  return [{
    subject: 'control plane update',
    text: `Control-plane update to ${build} failed at ${record.failedStep}${running}${reason}`,
    next: 'The deploy watch retries automatically; inspect the deploy unit journal if it repeats',
  }];
}

/** GY-3746, GY-3864: an install following Mainworks takes a newer build at most once an hour, and anyway 4 hours after its last successful update. */
const quietUpdateMs = 60 * 60_000, forcedUpdateMs = 4 * 60 * 60_000;
/** `master update now` leaves this file; the next pass takes the newer build at once and removes it. */
export const updateNowPath = (root: string) => join(stateDirectory(root), 'update-now');

/**
 * GY-3746, GY-3864: why an install following Mainworks's verified builds does not take `tip` yet,
 * or null to take it now: a hotfix, `master update now`, 4 hours since the last successful update
 * (`control.updatedAt`, falling back to `waiting.since` before any update is recorded), or over an
 * hour since the last update with no review, merge trial or acceptance run in flight.
 */
export async function updateWait(tip: string, previous: string | null, ports: Pick<DeployWatchPorts, 'busy' | 'hotfix'>, control: ControlPlaneRecord | null, nowFile: string): Promise<ControlPlaneRecord['waiting']> {
  if (existsSync(nowFile)) { await rm(nowFile, { force: true }); return null; }
  if (previous && await ports.hotfix?.(previous, tip).catch(() => false)) return null;
  const now = Date.now(), since = control?.waiting?.since ?? new Date(now).toISOString();
  const last = control?.updatedAt ? Date.parse(control.updatedAt) : null;
  const clock = last !== null && Number.isFinite(last) ? last : Date.parse(since);
  if (now - clock >= forcedUpdateMs) return null;
  const recent = last !== null && now - last < quietUpdateMs;
  const busy = await ports.busy?.().catch(() => null) ?? null;
  if (!busy && !recent) return null;
  const why = [busy, last !== null ? `last update ${Math.floor((now - last) / 60_000)} minutes ago` : null].filter(Boolean).join(', ');
  return { tip, since, reason: `update to ${tip.slice(0, 12)} waits: ${why}` };
}

/** What one deploy runs a commit through, each throwing its failure's reason. */
export interface DeployWatchPorts {
  /** Fetches origin and answers the base branch's tip. */
  fetch(): Promise<string>;
  /**
   * GY-3199: the latest batch-gate-verified Mainworks commit as `refs/graphyard/verified` on
   * Mainworks's canonical upstream names it — a constant in the code, fetched with the host's
   * existing git access; null when the ref resolves to nothing. An install that does not gate
   * Mainworks itself serves only this commit, never the fetched main tip. Absent, the watch
   * deploys the fetched tip as before.
   */
  verifiedUpstream?(): Promise<string | null>;
  /** GY-3746: what is in flight on this install ('a review is running'), or null when nothing is. */
  busy?(): Promise<string | null>;
  /** GY-3746: a commit after the first, up to the second, is titled as a hotfix. */
  hotfix?(from: string, to: string): Promise<boolean>;
  /** The commit the checkout holds now: the tip served before the watch recorded one. */
  head(): Promise<string>;
  /** Publishes the ready CLI after health; production ports move a pointer, preserving loaded trees. */
  checkout(commit: string): Promise<void>;
  /** Builds the commit in the deploy's own build checkout; the watched checkout does not move for this. */
  build(commit: string): Promise<void>;
  /** Restarts the container or unit the control plane runs in. */
  restart(commit: string, options?: { noCache?: boolean }): Promise<void>;
  /** /healthz answers healthy at the commit. */
  health(commit: string): Promise<void>;
  /** GY-3700: one quick /healthz probe: the commit already serves healthy. */
  serves?(commit: string): Promise<boolean>;
  /** The first commit is an ancestor of, or equal to, the second: the second contains it. */
  contains?(ancestor: string, commit: string): Promise<boolean>;
  /** Advances the known-good coordinator pin the loop's unit loads, so the loop's restart loads the commit. */
  pin(commit: string): Promise<void>;
  /** After a verified deploy, removes the per-commit images of every commit but these (the serving tip and the previous one). */
  prune(keep: string[]): Promise<void>;
  /** The schema generation a commit's code migrates to, read from its source; null when it names none. */
  schema(commit: string): Promise<number | null>;
  /** The database's schema generation, or null when it cannot be read. */
  database(): Promise<number | null>;
  /**
   * GY-3347: brings a stopped control plane back without a new commit. Present when this
   * install's server runs as a compose stack; absent when there is no stack to bring up.
   */
  stoppedPlane?: StoppedPlanePorts;
  /** GY-3676: the lock file one deploy at a time holds on this control plane; absent, one beside the deploy record. */
  lockFile?: string;
  /** GY-4030: the install this watch deploys, as another install waiting on its image build reads it; absent, the served repository. */
  install?: string;
  /** GY-3703: the retry backoff; absent, deployRetryBackoffMs. */
  retryBackoffMs?: readonly number[];
}

/**
 * What the watch brings a stopped control plane back with (GY-3347): one quick /healthz probe,
 * `up` at the commit the record already serves — the stack's own image — and the recreate for the
 * compose failure that means the old Docker network id is gone.
 */
export interface StoppedPlanePorts {
  /** One quick /healthz probe: resolves healthy, throws when the plane is down. */
  health(): Promise<void>;
  /** Brings the stack up in the install's compose directory. */
  up(): Promise<string>;
  /** Recreates the containers — `down` then `up` — after `up` failed on a network that is gone. */
  recreate(): Promise<string>;
}

/** A compose `up` failure that means the old Docker network is gone, so the containers must be recreated rather than started. */
function networkMissing(text: string) {
  return /\bnetwork\b[^\n]*?\b(?:not found|needs to be (?:recreated|removed)|was found but has incorrect label)\b/i.test(text);
}

/** GY-3347: how many times one pass tries to bring a stopped plane back before recording one failure reason, the pause before the first retry, and how long health may take to answer after `up`. */
export const stoppedPlaneAttempts = 3;
const stoppedPlaneRetryMs = 5_000;
const stoppedPlaneHealthMs = 30_000;

/**
 * GY-3347: a stopped control plane comes back without a new commit. A pass that deploys nothing
 * probes the serving commit's /healthz; a plane that fails is brought back with `up` at the
 * commit the record already serves, recreating the containers when `up` fails because the old
 * Docker network id is gone, with a backoff between attempts. Three failures record one plain
 * reason beside the serving tip — where master status and the alert path already read deploy
 * failures — and a plane that answers again clears it. Returns whether the plane was down.
 */
async function recoverStoppedPlane(record: DeployRecord, ports: StoppedPlanePorts, write: (entry: Omit<DeployRecord, 'at' | 'repository'>) => Promise<void>, log: (line: string) => void): Promise<boolean> {
  try { await ports.health(); return false; } catch { /* the plane is down: bring it back */ }
  const tip = record.tip!;
  const waitHealthy = async () => {
    const deadline = Date.now() + stoppedPlaneHealthMs;
    for (;;) {
      try { return await ports.health(); } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(1_000);
      }
    }
  };
  let reason = 'unknown failure';
  for (let attempt = 1; attempt <= stoppedPlaneAttempts; attempt++) {
    try {
      log(`[mainworks-deploy] /healthz fails for the serving ${tip.slice(0, 12)}; bringing the stack up (attempt ${attempt} of ${stoppedPlaneAttempts})`);
      try { await ports.up(); } catch (error) {
        const text = message(error);
        if (!networkMissing(text)) throw error;
        log(`[mainworks-deploy] the stack's Docker network is gone; recreating the containers: ${text}`);
        await ports.recreate();
      }
      await waitHealthy();
      await write({ tip, failed: null, reason: null, verified: record.verified });
      log(`[mainworks-deploy] the stack is up again at ${tip.slice(0, 12)}`);
      return true;
    } catch (error) { reason = message(error); }
    if (attempt < stoppedPlaneAttempts) await delay(stoppedPlaneRetryMs * 2 ** (attempt - 1));
  }
  const plain = `the stopped control plane was not brought back up at ${tip.slice(0, 12)} in ${stoppedPlaneAttempts} attempts: ${reason}`;
  await write({ tip, failed: tip, reason: plain, verified: record.verified });
  log(`[mainworks-deploy] ${plain}`);
  return true;
}

// Publication follows strict server health; production ports atomically select a retained artifact.
const steps = ['build', 'restart', 'health', 'checkout', 'pin'] as const;
/** Rollback attempts before the watch stops retrying one and waits for the base to move. */
const rollbackAttempts = 5;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One pass: fetch, and when the base tip (the batch gate's latest verified commit, once the gate
 * names this repository) is new, deploy it. A failure at any step rolls back to the
 * previous tip through the same steps and records the failed tip, retried after a backoff —
 * unless the failed deploy may have migrated the database, which the previous tip would refuse: a
 * failure from the restart on whose tip's code migrates past the previous tip's is kept and recorded
 * as served, unless the database reads at a generation the previous tip supports. A rollback that
 * fails is retried on later passes, up to rollbackAttempts, and is recorded as served only once it
 * succeeds; a new base tip is deployed in its place.
 *
 * GY-3199: an install that does not gate this checkout's repository — every install for another
 * repository — serves only the commit Mainworks's own gate publishes at refs/graphyard/verified on
 * its canonical upstream, never a fetched main tip the gate has not verified. Every pass writes
 * the control plane's own record
 * (.graphyard/control-plane.json: the commit it runs, last check, last update, last failed step),
 * separate from the deploy record.
 */
export async function deployOnce(file: string, ports: DeployWatchPorts, log: (line: string) => void = line => console.error(line), owner: string | null = null): Promise<'unchanged' | 'deployed' | 'rolled-back' | 'kept' | 'restoring'> {
  // GY-3676: one deploy at a time per control plane; a watcher that finds the lock held does nothing this round.
  const lock = ports.lockFile ?? join(dirname(file), 'deploy.lock');
  if (!await takeLock(lock)) { log(`[mainworks-deploy] another deploy holds ${lock}; skipping this round`); return 'unchanged'; }
  try { return await deployPass(file, ports, log, owner); } finally { await rm(lock, { force: true }); }
}

async function deployPass(file: string, ports: DeployWatchPorts, log: (line: string) => void, owner: string | null): Promise<'unchanged' | 'deployed' | 'rolled-back' | 'kept' | 'restoring'> {
  // GY-3119: once the loop's batch gate names this repository, only its latest verified commit serves, never the fetched main tip.
  const fetched = await ports.fetch();
  const verified = servedVerified(join(dirname(file), 'main-gate.json'), owner);
  const followsUpstream = !verified && !!ports.verifiedUpstream && owner?.toLowerCase() === mainworksRepository;
  const upstream = followsUpstream ? await ports.verifiedUpstream!() : null;
  const gated = verified ?? upstream;
  const tip = verified ?? (followsUpstream ? upstream : fetched) as string | null;
  const controlFile = controlPlaneRecordPath(dirname(dirname(file)));
  let stored = readDeployRecord(file);
  // GY-3703: a failed verified commit is tried again after a backoff: the verified commit may not move
  // for days, and a transient failure must not freeze deploys until it does.
  let retries = 0;
  if (stored?.failed === tip && !stored.restore) {
    const backoff = ports.retryBackoffMs ?? deployRetryBackoffMs;
    const failedAt = readControlPlaneRecord(controlFile)?.failedAt ?? stored.at;
    const wait = backoff[Math.min(stored.retries ?? 0, backoff.length - 1)]!;
    if (Date.now() - Date.parse(failedAt) >= wait) { retries = (stored.retries ?? 0) + 1; stored = { ...stored, failed: null }; }
  }
  const record = stored ?? { tip: await ports.head(), failed: null, reason: null, at: '' };
  const previous = record.restore ?? record.tip;
  const write = (entry: Omit<DeployRecord, 'at' | 'repository'>) => writeDeployRecord(file, { ...entry, ...(retries && entry.failed === tip ? { retries } : {}), repository: owner });
  const noteControl = async (entry: Partial<Omit<ControlPlaneRecord, 'at'>>) => {
    const current = readControlPlaneRecord(controlFile) ?? { commit: previous, checkedAt: null, updatedAt: null, verified: null, verifiedSeenAt: null, failedStep: null, failedReason: null, failedAt: null };
    await writeControlPlaneRecord(controlFile, { ...current, commit: current.commit ?? previous, ...entry });
  };
  // GY-4030: installs on one machine take turns building and exporting their image under the host's image lock;
  // a build that still loses its BuildKit lease is tried once more after the other build ends.
  let retried: string | null = null;
  const restartInTurn = (commit: string, noCache = false) => withHostLock(imageLock, () => ports.restart(commit, { noCache }), {
    holder: ports.install ?? owner ?? 'another install',
    onWait: holder => {
      log(`[mainworks-deploy] waits for ${holder}'s image build to finish`);
      return noteControl({ waiting: { tip: commit, reason: `Waits for ${holder}'s image build to finish`, since: new Date().toISOString() } });
    },
  }).finally(() => noteControl({ waiting: null }));
  const restartStep = async (commit: string) => {
    try { await restartInTurn(commit); } catch (error) {
      if (!/lease does not exist|failed to ingest/i.test(message(error))) throw error;
      const failure = /lease does not exist/i.test(message(error)) ? 'lease' : 'ingest';
      log(`[mainworks-deploy] the image build of ${commit.slice(0, 12)} had a BuildKit ${failure} error; retrying once: ${message(error)}`);
      retried = `The image build of ${commit.slice(0, 12)} was retried once after a BuildKit ${failure} error`;
      await noteControl({ retried });
      try { await restartInTurn(commit); } catch (retryError) {
        const blob = message(error).match(/sha256:[a-f0-9]{64}/i)?.[0];
        if (!blob || !message(retryError).includes(blob) || !/lease does not exist|failed to ingest/i.test(message(retryError))) throw retryError;
        retried = `The image build of ${commit.slice(0, 12)} was retried without build cache after repeated BuildKit errors for blob ${blob}`;
        log(`[mainworks-deploy] ${retried}`);
        await noteControl({ retried });
        await restartInTurn(commit, true);
      }
    }
  };
  const run = async (commit: string) => {
    for (const step of steps) {
      log(`[mainworks-deploy] ${step} ${commit.slice(0, 12)}`);
      try { await (step === 'restart' ? restartStep(commit) : ports[step](commit)); } catch (error) {
        // GY-3676: a restart that failed while the commit already serves healthy (another deploy restarted it) is no failure.
        if (step === 'restart' && await ports.health(commit).then(() => true, () => false)) { log(`[mainworks-deploy] restart failed but ${commit.slice(0, 12)} already serves healthy: ${message(error)}`); continue; }
        throw Object.assign(new Error(`${step} failed: ${message(error)}`), { step });
      }
    }
  };
  const restore = async (previous: string, failed: string, reason: string, attempts: number) => {
    try { await run(previous); } catch (error) {
      log(`[mainworks-deploy] the rollback to ${previous.slice(0, 12)} failed (attempt ${attempts}): ${message(error)}`);
      await write({ tip: null, failed, restore: previous, attempts, reason: `${reason}; the rollback to ${previous.slice(0, 12)} failed (attempt ${attempts} of ${rollbackAttempts}): ${message(error)}` });
      return 'restoring' as const;
    }
    await write({ tip: previous, failed, reason });
    return 'rolled-back' as const;
  };
  // The check itself is a fact of the record: when it ran and which verified commit it saw (the
  // first sighting of a new one starts the staleness clock, GY-3199).
  {
    const current = readControlPlaneRecord(controlFile);
    const firstSeen = current?.verified !== gated && gated ? new Date().toISOString() : current?.verifiedSeenAt ?? null;
    await noteControl({ checkedAt: new Date().toISOString(), verified: gated, verifiedSeenAt: firstSeen });
  }
  // Nothing verified to adopt upstream: never fall back to a main tip the gate has not verified.
  if (tip === null) return 'unchanged';
  if (record.restore && tip === record.failed) {
    const attempts = (record.attempts ?? 0) + 1;
    if (attempts > rollbackAttempts) return 'unchanged';
    return restore(record.restore, tip, record.reason ?? '', attempts);
  }
  // GY-3137: serving only moves forward: a verified commit the served one already contains (or that diverges from it) never deploys.
  const behind = gated && previous && tip !== previous && ports.contains ? !(await ports.contains(previous, tip).catch(() => false)) : false;
  if (behind) return 'unchanged';
  if (tip === previous || tip === record.failed) {
    // The base tip is what the checkout already serves: nothing to deploy, but a record an older
    // watcher left without the repository it serves gains the name on this first pass, so master
    // status reads the serving commit before the next merge rewrites the record (GY-2957).
    if (stored && stored.tip === tip && (stored.repository ?? null) !== owner) await write({ tip, failed: stored.failed, reason: stored.reason, restore: stored.restore, attempts: stored.attempts });
    // GY-3347: a stopped control plane comes back without a new commit. This pass deploys
    // nothing and no rollback is mid-flight (that is a deploy at work), so the watch brings the
    // stack up at the commit it already recorded as serving.
    if (ports.stoppedPlane && record.tip && !record.restore) await recoverStoppedPlane(record, ports.stoppedPlane, write, log);
    return 'unchanged';
  }
  // GY-3746: an install following Mainworks updates at a quiet moment, so a restart never cuts a review or trial short.
  if (followsUpstream) {
    const control = readControlPlaneRecord(controlFile);
    const waiting = await updateWait(tip, previous, ports, control, updateNowPath(dirname(dirname(file))));
    if (waiting) {
      if (waiting.reason !== control?.waiting?.reason) log(`[mainworks-deploy] ${waiting.reason}`);
      await noteControl({ waiting });
      return 'unchanged';
    }
    if (control?.waiting) await noteControl({ waiting: null });
  }
  // GY-3700: a watch started after a handover finds the commit already serving: record it, build and restart nothing.
  // GY-3902: a watch killed between health and checkout left the CLI and loop pin behind; move them first (both idempotent).
  if (await ports.serves?.(tip).catch(() => false)) {
    await ports.checkout(tip);
    await ports.pin(tip);
    await write({ tip, failed: null, reason: null, verified: gated === tip });
    await noteControl({ commit: tip, failedStep: null, failedReason: null, failedAt: null });
    log(`[mainworks-deploy] ${tip.slice(0, 12)} already serves healthy; recorded as serving`);
    return 'unchanged';
  }
  const before = await ports.database().catch(() => null);
  try {
    await run(tip);
    await write({ tip, failed: null, reason: null, verified: gated === tip });
    await noteControl({ commit: tip, updatedAt: new Date().toISOString(), failedStep: null, failedReason: null, failedAt: null, retried });
    log(`[mainworks-deploy] serving ${tip.slice(0, 12)}`);
  } catch (error) {
    const reason = message(error), step = (error as { step?: string }).step;
    const failedControl = () => noteControl({ failedStep: step ?? null, failedReason: reason.slice(0, 2000), failedAt: new Date().toISOString() });
    if (!previous) { await write({ tip: null, failed: tip, reason }); await failedControl(); return 'rolled-back'; }
    if (step === 'build') {
      // No server or published CLI changed: leave the healthy pairing running.
      await write({ tip: previous, failed: tip, reason });
      await failedControl();
      return 'rolled-back';
    }
    // From the restart on — health and, since GY-2978, the checkout move too — the server has started on the tip's
    // code, which may have migrated the database; the previous tip runs only on a generation it supports.
    {
      const [after, supported, migrates] = await Promise.all([ports.database().catch(() => null), ports.schema(previous).catch(() => null), ports.schema(tip).catch(() => null)]);
      const ceiling = supported ?? before, reached = after ?? migrates;
      if (ceiling === null || reached === null || reached > ceiling) {
        const why = after !== null && before !== null && after > before ? `it migrated the database from generation ${before} to ${after}` : `the database may be at generation ${reached ?? 'unknown'}, past the ${ceiling ?? 'unknown'} the previous tip supports`;
        log(`[mainworks-deploy] ${tip.slice(0, 12)} ${reason}; kept: ${why}, which the previous tip would refuse`);
        await ports.pin(tip).catch(failed => log(`[mainworks-deploy] the pin of ${tip.slice(0, 12)} failed: ${message(failed)}`));
        // The server serves the kept tip, so the CLI checkout follows it too, best-effort like the pin.
        await ports.checkout(tip).catch(failed => log(`[mainworks-deploy] the checkout of ${tip.slice(0, 12)} failed: ${message(failed)}`));
        await write({ tip, failed: null, reason: `${reason}; kept because ${why}` });
        await noteControl({ commit: tip, updatedAt: new Date().toISOString(), failedStep: step ?? null, failedReason: `${reason}; kept because ${why}`.slice(0, 2000), failedAt: new Date().toISOString() });
        return 'kept';
      }
    }
    log(`[mainworks-deploy] ${tip.slice(0, 12)} ${reason}; rolling back to ${previous.slice(0, 12)}`);
    const outcome = await restore(previous, tip, reason, 1);
    await failedControl();
    return outcome;
  }
  // GY-3902: cleanup is not part of the deploy: a prune that fails is logged and nothing rolls back.
  await ports.prune(previous ? [tip, previous] : [tip]).catch(error => log(`[mainworks-deploy] the image prune after ${tip.slice(0, 12)} failed: ${message(error)}`));
  return 'deployed';
}

/**
 * `upgrade --watch`: a pass every interval until stopped; a pass that throws (a fetch that failed) is logged and retried.
 * `repository` is the record's owner: the repository the watch serves. `handover` runs after a pass
 * served a new tip; it may stop the watch by throwing, so the process that restarts it loads the
 * code the checkout published — the watch runs the code it deploys (GY-3123).
 */
export async function watchMain(file: string, ports: DeployWatchPorts, options: { intervalMs: number; once?: boolean; signal?: AbortSignal; log?: (line: string) => void; repository?: string | null; handover?: (tip: string) => Promise<void> }) {
  const log = options.log ?? (line => console.error(line));
  for (;;) {
    let served: Awaited<ReturnType<typeof deployOnce>> | undefined;
    try { served = await deployOnce(file, ports, log, options.repository ?? null); } catch (error) { log(`[mainworks-deploy] the pass failed and runs again: ${error instanceof Error ? error.message : String(error)}`); }
    if ((served === 'deployed' || served === 'kept') && options.handover) await options.handover(readDeployRecord(file)?.tip ?? '');
    if (options.once || options.signal?.aborted) return;
    try { await delay(options.intervalMs, undefined, { signal: options.signal }); } catch { return; }
  }
}

/**
 * The watch's release handover (GY-3123): after a pass served `tip`, a process not running that
 * commit's code calls `stop` and throws the release handover, so the launcher restarts the watch on
 * the code it serves. `running` names the commit this process's code comes from.
 */
export const releaseHandover = (running: () => string | null, stop: () => void, repoint: () => Promise<string | null> = async () => null, log: (line: string) => void = line => console.error(line)) => {
  // GY-3756: the unit is pointed at the served release first; a rewrite that fails keeps this process
  // running, reported once per tip, since a restart would only load the same old release again.
  let reported: string | null = null;
  return async (tip: string) => {
    if (!tip || running() === tip) return;
    const refused = await repoint();
    if (refused) {
      if (reported !== tip) log(`[mainworks-deploy] the watch stays on ${running()?.slice(0, 12) ?? 'its release'} and does not hand over to ${tip.slice(0, 12)}: ${refused}`);
      reported = tip;
      return;
    }
    stop();
    throw Object.assign(new Error(`[mainworks-deploy] the watch hands itself over to ${tip.slice(0, 12)}: it serves code this process is not running, and the restart loads it`), { releaseHandover: true });
  };
};

/** The managed repository's serving, as the dashboard header reads it (GY-2964). */
export interface ManagedDeploy {
  /** The managed repository this answers for. */
  repository: string;
  /** A deploy record names this repository as the one it serves; its tip is null while a rollback restores (GY-3902). */
  configured: boolean;
  /** The commit that deploy serves; null when no deploy of this repository is configured. */
  tip: string | null;
  /** When that deploy was recorded. */
  at: string | null;
  /** The base branch's tip as the shared checkout holds it; null when it cannot be read. */
  main: string | null;
  /** Merged changes on the base branch since the configured deploy's commit; null when unreadable. */
  pending: number | null;
}

/**
 * What the managed repository's own deployment serves, read like master status reads it (GY-2955):
 * only a deploy record naming this repository as the one it serves counts, and the base tip comes
 * from the shared checkout's ref. The control plane's own build revision and its deployment are
 * never a stand-in for another repository's release health, so a managed install without such a
 * record reads unconfigured — "No deploy configured · main <tip>" — never a serving claim.
 */
export async function managedDeploy(repository: string, baseBranch: string, root: string | null | undefined, git?: GitRunner | null): Promise<ManagedDeploy> {
  const record = root ? readDeployRecord(deployRecordPath(root)) : null;
  const configured = !!record && record.repository?.toLowerCase() === repository.toLowerCase();
  let main: string | null = null, pending: number | null = null;
  if (root && git) {
    for (const ref of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
      const tip = await git(['rev-parse', '--verify', '--quiet', ref]);
      const sha = tip.stdout.trim();
      if (tip.status === 0 && /^[0-9a-f]{40}$/.test(sha)) { main = sha; break; }
    }
    if (configured && record!.tip && main) {
      const since = await git(['rev-list', '--count', `${record!.tip}..${main}`]);
      pending = since.status === 0 && /^\d+$/.test(since.stdout.trim()) ? Number(since.stdout.trim()) : null;
    }
  }
  return { repository, configured, tip: configured ? record!.tip : null, at: configured && record!.tip ? record!.at : null, main, pending };
}

/** The git toplevel of a directory, or null when it is not in a checkout — the server's fallback serving root (its own working directory). */
export const repositoryToplevel = (directory: string): string | null => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

/** A git read that answers its stdout and throws when the read fails, so a missing ref is a caught throw, never a silent answer. */
export type GitRead = (args: readonly string[]) => Promise<string>;

/**
 * What serves the managed repository now (GY-2976): the deploy record naming it as the one it
 * serves, or — when main declares a node application in graphyard.json and the deploy unit's serve pass has run
 * — what that pass serves: the served commit, whether it is main, how far main is ahead, the last
 * build failure, and the declared serve's URL (null while nothing is declared). The serve record
 * is the repository's own serving truth, so it stands even beside an unconfigured deploy record;
 * the URL and the failure are the declared serve's alone.
 */
export interface ServingReport {
  onboarding: AppOnboarding;
  /** Nothing serves this repository: no deploy record names it and no serve pass has served or failed. */
  unconfigured: boolean;
  /** The served commit (the declared serve's when one is recorded, else the deploy record's); null when nothing serves. */
  commit: string | null;
  /** The base branch's tip as the shared checkout holds it; null when it cannot be read. */
  main: string | null;
  /** When the served commit was deployed (the serve's start, else the deploy record's time); null when nothing serves. */
  deployedAt: string | null;
  /** Whether the served commit is main; null when either is unreadable. */
  atMain: boolean | null;
  /** The last failure: the declared serve's build failure, else a configured deploy's failed tip. */
  failedDeploy: { tip: string | null; reason: string | null; restoring: string | null } | null;
  /** Merged changes the base branch holds since the served commit; null when unreadable. */
  pending: number | null;
  /** The declared serve's URL, its last build failure, and the served commit's required cases' verdict (null while they have not run against it); null when the repository declares no serve. */
  serve: { url: string | null; failure: { commit: string; reason: string | null } | null; check: ServeCheck | null } | null;
}

export async function servingReport(root: string | null | undefined, repository: string, baseBranch: string, git?: GitRead | null): Promise<ServingReport> {
  const record = root ? readDeployRecord(deployRecordPath(root)) : null;
  const serve = root ? readServeRecord(serveRecordPath(root)) : null;
  const configured = !!record && record.repository?.toLowerCase() === repository.toLowerCase();
  const commit = serve?.commit ?? (configured ? record!.tip : null);
  const failed = serve?.failed ? { tip: serve.failed, reason: serve.reason }
    : !serve && configured && record!.failed ? { tip: record!.failed, reason: record!.reason } : null;
  let main: string | null = null, pending: number | null = null;
  if (root && git) {
    for (const ref of [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`]) {
      try { const sha = (await git(['rev-parse', '--verify', ref])).trim(); if (/^[0-9a-f]{40}$/.test(sha)) { main = sha; break; } } catch { /* the ref is absent here */ }
    }
    if (commit && main) {
      try { const count = (await git(['rev-list', '--count', `${commit}..${main}`])).trim(); pending = /^\d+$/.test(count) ? Number(count) : null; } catch { /* unreadable */ }
    }
  }
  let onboarding = appOnboarding(null);
  if (main && git) {
    try { onboarding = appOnboarding(JSON.parse(await git(['show', `${main}:graphyard.json`]))); } catch { /* missing or invalid main declaration stays not onboarded */ }
  }
  return {
    onboarding,
    unconfigured: !commit && !configured,
    commit, main,
    deployedAt: serve?.commit ? serve.started ?? serve.at : configured && record!.tip ? record!.at : null,
    atMain: commit && main ? commit === main : null,
    failedDeploy: failed ? { tip: failed.tip, reason: failed.reason, restoring: !serve && configured ? record!.restore ?? null : null } : null,
    pending,
    serve: serve ? { url: serve.url ?? null, failure: serve.failed ? { commit: serve.failed, reason: serve.reason } : null, check: serve.check ?? null } : null,
  };
}

/** The health URL graphyard.json declares as `app.healthUrl` (GY-3452): an install that deploys elsewhere answers its live commit there. */
function declaredHealthUrl(root: string | null | undefined): string | null {
  if (!root) return null;
  try {
    const url = JSON.parse(readFileSync(join(root, 'graphyard.json'), 'utf8'))?.app?.healthUrl;
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
  } catch { return null; }
}

let health: { url: string; at: number; commit: string | null } | null = null;
/**
 * The commit the health URL answers, asked at most once a minute however often the dashboard polls;
 * null when it does not answer one. Only the first ask is awaited: later ones refresh in the
 * background, so a slow health URL never holds /api/status.
 */
async function healthCommit(url: string, now: number, fetcher: typeof fetch): Promise<string | null> {
  const ask = () => servedCommit(url, fetcher).catch(() => null);
  if (health?.url !== url) {
    const entry = health = { url, at: now, commit: null as string | null };
    return entry.commit = await ask();
  }
  if (now - health.at >= 60_000) {
    const entry = health; entry.at = now;
    void ask().then(commit => { entry.commit = commit; });
  }
  return health.commit;
}

/** What users have (GY-3452): the live commit, and the merged items it does not contain yet, by key. */
export interface LiveRelease { commit: string; waiting: string[] }

/**
 * The live commit — what `app.healthUrl` answers, else what the serve or deploy record (or the
 * production watch) serves — and every merged item whose merge commit main holds but the live
 * commit does not. Null when nothing names a live commit or the checkout cannot place it, so the
 * dashboard claims nothing shipped.
 */
export async function liveRelease(root: string | null | undefined, served: string | null, main: string | null, work: readonly Pick<Work, 'key' | 'stage' | 'delivery'>[], git: GitRead | null | undefined, options: { now?: number; fetcher?: typeof fetch } = {}): Promise<LiveRelease | null> {
  const url = declaredHealthUrl(root);
  const answered = url ? await healthCommit(url, options.now ?? Date.now(), options.fetcher ?? fetch) : null;
  if (!git || !main || !(answered ?? served)) return null;
  try {
    const commit = (await git(['rev-parse', '--verify', `${answered ?? served}^{commit}`])).trim();
    const notLive = new Set((await git(['rev-list', `${commit}..${main}`])).split('\n').map(line => line.trim()).filter(Boolean));
    return { commit, waiting: work.filter(item => item.stage === 'done' && item.delivery?.mergeSha && notLive.has(item.delivery.mergeSha)).map(item => item.key) };
  } catch { return null; }
}
