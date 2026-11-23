// Concern: GY-3634 — repeatable trial speed benchmark: run a fixed checked-in file list
// through the real trial runner and hosts as a proofless pseudo-item, store the last 200 results,
// schedule in the loop after new deploys and at most every 6h when idle, surface regressions in
// master status, and compare REF against main per step.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { cpuStatTotals } from './daemon/cpu-pressure.js';
import { deployRecordPath, readDeployRecord } from './deploy-watch.js';
import { worktreeRoot } from './install/worktree-root.js';
import { loadStoredMasterConfig } from './master/config.js';
import { mergeQueue } from './merge-writer/executor.js';
import { cpuCelsius } from './merge-writer/trial-load.js';
import { runTrial, type RunTrialInput, type TrialRunMetrics } from './merge-writer/trial.js';
import { cliCommit } from './protocol-version.js';
import type { Work } from './model.js';
import type { MergeLedgerState } from './model/merge-ledger.js';
import type { DaemonState } from './daemon/state.js';
import { stateDirectory } from './install/layout.js';

export const defaultBenchFilesPath = 'bench/trial-files.txt';
export const benchResultsLimit = 200;
export const benchResultsPath = (root: string) => join(stateDirectory(root), 'bench-results.jsonl');
export const benchTrialKey = 'bench-trial';
export const benchIntervalMs = 6 * 60 * 60_000;
export const benchRegressionThreshold = 0.25;
export const benchWindowSize = 10;
const benchTimeoutMs = 60 * 60_000;
const ticksPerSecond = 100;

export interface BenchSteps {
  checkout: number;
  build: number;
  selection: number;
  e2e: number;
  browser: number;
  [step: string]: number;
}

export interface BenchResult {
  at: string;
  commit: string;
  build: string | null;
  fileList: string;
  fileListHash: string;
  files: number;
  outcome: 'pass' | 'fail';
  wallSeconds: number;
  cpuSeconds: number;
  steps: BenchSteps;
  shardsPerHost: Record<string, number>;
  slowestFiles: { file: string; seconds: number }[];
  hostTemperatures: Record<string, number | null>;
}

export interface BenchAttention {
  subject: string;
  text: string;
  next: string;
}

export interface BenchStatus {
  latest: BenchResult;
  median: { count: number; wallSeconds: number; cpuSeconds: number } | null;
  wallChangePercent: number | null;
  cpuChangePercent: number | null;
  attention: BenchAttention | null;
}

export interface BenchStepDiff {
  baseline: number;
  candidate: number;
  deltaSeconds: number;
  deltaPercent: number | null;
}

export interface BenchComparison {
  baseline: Pick<BenchResult, 'commit' | 'wallSeconds' | 'cpuSeconds' | 'outcome'>;
  candidate: Pick<BenchResult, 'commit' | 'wallSeconds' | 'cpuSeconds' | 'outcome'>;
  wallDeltaSeconds: number;
  wallDeltaPercent: number | null;
  cpuDeltaSeconds: number;
  cpuDeltaPercent: number | null;
  steps: Record<string, BenchStepDiff>;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Reads the checked-in list of test files and computes its stable hash. */
export function readBenchFileList(root: string, filesPath = defaultBenchFilesPath): { fileList: string; files: string[]; fileListHash: string } {
  const absolute = isAbsolute(filesPath) ? filesPath : join(root, filesPath);
  if (!existsSync(absolute)) throw new Error(`Benchmark file list not found: ${absolute}`);
  const files = readFileSync(absolute, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  if (!files.length) throw new Error(`Benchmark file list is empty: ${absolute}`);
  const fileListHash = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
  const fileList = isAbsolute(filesPath) ? relative(root, filesPath) || filesPath : filesPath;
  return { fileList, files, fileListHash };
}

/** Reads stored benchmark results from the JSONL results file. */
export function readBenchResults(file: string): BenchResult[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        try { return [JSON.parse(line) as BenchResult]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

/** Appends one result to the results file, keeping only the last `limit` (default 200) entries. */
export async function appendBenchResult(file: string, result: BenchResult, limit = benchResultsLimit): Promise<void> {
  const existing = readBenchResults(file);
  const kept = [...existing, result].slice(-limit);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, `${kept.map(entry => JSON.stringify(entry)).join('\n')}\n`);
  await rename(temp, file);
}

/** Resolves `ref` (default: origin/main, else main, else HEAD) to a full 40-hex commit SHA. */
async function resolveRef(root: string, ref: string | undefined, run: ChildRun): Promise<string> {
  const candidates = ref ? [ref] : ['origin/main', 'main', 'HEAD'];
  for (const candidate of candidates) {
    try {
      const sha = String(await run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])).trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    } catch { /* try next */ }
  }
  throw new Error(`Could not resolve git ref ${ref ?? 'main'} in ${root}`);
}

/** Normalizes `onTiming` step labels from `runTrial` into the benchmark's per-step seconds map. */
function recordStepTiming(steps: BenchSteps, label: string, durationMs: number): void {
  const seconds = round2(Math.max(0, durationMs) / 1000);
  if (label.startsWith('tests: ') && label.includes(' lanes, breadth ')) return;
  if (label === 'tests') return;
  if (label === 'checkout') { steps.checkout = round2(steps.checkout + seconds); return; }
  if (label === 'build' || label === 'build: reused') { steps.build = round2(steps.build + seconds); return; }
  if (label === 'selection') { steps.selection = round2(steps.selection + seconds); return; }
  if (label === 'tests: e2e') { steps.e2e = round2(steps.e2e + seconds); return; }
  if (/browser/i.test(label)) { steps.browser = round2(steps.browser + seconds); return; }
  steps[label] = round2((steps[label] ?? 0) + seconds);
}

function readProcStat(): string | null {
  try { return readFileSync('/proc/stat', 'utf8'); } catch { return null; }
}

/**
 * Runs one reference trial benchmark on `ref` (default current main) with `bench/trial-files.txt`
 * through the real trial runner (`runTrial`) and hosts as a proofless pseudo-item, prints one JSON
 * result, and appends it to the results file.
 */
export async function benchTrial(input: {
  root: string;
  base?: string;
  ref?: string;
  filesPath?: string;
  resultsFile?: string;
  build?: string | null;
  run?: ChildRun;
  remote?: RunTrialInput['remote'];
  timeoutMs?: number;
  now?: () => number;
  isQueued?: () => boolean;
  readCpuStat?: () => string | null;
  print?: (line: string) => void;
}): Promise<BenchResult> {
  if (input.isQueued?.()) {
    throw new Error('A change is queued for merge; retry once the queue is empty');
  }
  const run = input.run ?? defaultChildRun;
  const now = input.now ?? Date.now;
  const readStat = input.readCpuStat ?? readProcStat;
  const commit = await resolveRef(input.root, input.ref, run);
  const { fileList, files, fileListHash } = readBenchFileList(input.root, input.filesPath);
  const base = input.base ?? await loadStoredMasterConfig(input.root).then(cfg => worktreeRoot(input.root, cfg), () => join(stateDirectory(input.root), 'bench-worktrees'));
  const resultsFile = input.resultsFile ?? benchResultsPath(input.root);
  const build = input.build !== undefined
    ? input.build
    : readDeployRecord(deployRecordPath(input.root))?.tip ?? cliCommit(input.root);

  const steps: BenchSteps = { checkout: 0, build: 0, selection: 0, e2e: 0, browser: 0 };
  const captured: { metrics: TrialRunMetrics | null } = { metrics: null };
  const startTemp = await cpuCelsius().catch(() => null);
  const statBefore = (() => { const text = readStat(); return text ? cpuStatTotals(text) : null; })();
  const procBefore = process.cpuUsage();
  const startedAt = now();

  const verdict = await runTrial({
    root: input.root,
    base,
    mergeSha: commit,
    changedFiles: files,
    timeoutMs: input.timeoutMs ?? benchTimeoutMs,
    key: benchTrialKey,
    caches: false,
    retries: 0,
    run,
    selectFiles: async () => files,
    onTiming: (step, durationMs) => recordStepTiming(steps, step, durationMs),
    onMetrics: metrics => { captured.metrics = metrics; },
    ...(input.remote ? { remote: input.remote } : {}),
  });

  const wallSeconds = round2(Math.max(0, verdict.durationMs || (now() - startedAt)) / 1000);
  const statAfter = (() => { const text = readStat(); return text ? cpuStatTotals(text) : null; })();
  const procDelta = process.cpuUsage(procBefore);
  let cpuSeconds: number;
  if (statBefore && statAfter && statAfter.total > statBefore.total) {
    const busyTicks = (statAfter.total - statAfter.idle - statAfter.steal) - (statBefore.total - statBefore.idle - statBefore.steal);
    cpuSeconds = round2(Math.max(0, busyTicks) / ticksPerSecond);
  } else {
    cpuSeconds = round2((procDelta.user + procDelta.system) / 1_000_000);
  }

  const metrics = captured.metrics;
  const hostTemperatures = metrics && Object.keys(metrics.hostTemperatures).length
    ? metrics.hostTemperatures
    : { [hostname()]: startTemp };
  const shardsPerHost = metrics?.shardsPerHost ?? {};
  const slowestFiles = (metrics?.fileDurations ?? [])
    .slice()
    .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file))
    .slice(0, 5)
    .map(entry => ({ file: entry.file, seconds: round2(entry.durationMs / 1000) }));

  const passed = verdict.build === 'pass' && verdict.tests.failed.length === 0 && (verdict.runnerExit === 0 || verdict.runnerExit == null);
  const result: BenchResult = {
    at: new Date(now()).toISOString(),
    commit,
    build,
    fileList,
    fileListHash,
    files: files.length,
    outcome: passed ? 'pass' : 'fail',
    wallSeconds,
    cpuSeconds,
    steps,
    shardsPerHost,
    slowestFiles,
    hostTemperatures,
  };

  await appendBenchResult(resultsFile, result);
  const line = `${JSON.stringify(result)}\n`;
  if (input.print) input.print(line);
  else process.stdout.write(line);
  return result;
}

/**
 * Decides whether the loop should run a benchmark now:
 * once after each deploy of a new build, and at most once every 6 hours otherwise,
 * only when no trial is queued and no benchmark is already in flight.
 */
export function benchDue(input: {
  results: readonly BenchResult[];
  currentBuild: string | null;
  now: number;
  trialQueued: boolean;
  inFlight: boolean;
}): { due: boolean; reason: string | null } {
  if (input.trialQueued || input.inFlight) return { due: false, reason: null };
  const last = input.results.at(-1);
  if (!last) return { due: true, reason: 'no benchmark recorded yet' };
  if (input.currentBuild && last.build !== input.currentBuild) {
    return { due: true, reason: `new build ${input.currentBuild.slice(0, 12)} deployed` };
  }
  const lastAt = Date.parse(last.at);
  if (!Number.isFinite(lastAt) || input.now - lastAt >= benchIntervalMs) {
    return { due: true, reason: '6-hour interval elapsed' };
  }
  return { due: false, reason: null };
}

/**
 * Summarizes the latest benchmark result beside the median of the previous ten on the same
 * file list (wall and CPU with percentage change), and produces one attention line when wall
 * time is more than 25% above that median, naming the step that grew most.
 */
export function benchStatus(results: readonly BenchResult[]): BenchStatus | null {
  const latest = results.at(-1);
  if (!latest) return null;
  const previous = results
    .slice(0, -1)
    .filter(entry => entry.fileListHash === latest.fileListHash)
    .slice(-benchWindowSize);
  if (!previous.length) {
    return { latest, median: null, wallChangePercent: null, cpuChangePercent: null, attention: null };
  }
  const medianWall = round2(median(previous.map(entry => entry.wallSeconds)));
  const medianCpu = round2(median(previous.map(entry => entry.cpuSeconds)));
  const wallChangePercent = medianWall > 0 ? round1(((latest.wallSeconds - medianWall) / medianWall) * 100) : null;
  const cpuChangePercent = medianCpu > 0 ? round1(((latest.cpuSeconds - medianCpu) / medianCpu) * 100) : null;

  let attention: BenchAttention | null = null;
  if (medianWall > 0 && (latest.wallSeconds - medianWall) / medianWall > benchRegressionThreshold) {
    let worstStep = 'tests';
    let worstGrowth = -Infinity;
    for (const [step, value] of Object.entries(latest.steps)) {
      const prevMedian = median(previous.map(entry => entry.steps[step] ?? 0));
      const growth = value - prevMedian;
      if (growth > worstGrowth) {
        worstGrowth = growth;
        worstStep = step;
      }
    }
    const pct = Math.round(((latest.wallSeconds - medianWall) / medianWall) * 100);
    const refHint = previous.at(-1)!.commit.slice(0, 12);
    attention = {
      subject: 'bench trial',
      text: `Trial benchmark wall time is ${latest.wallSeconds}s (+${pct}% vs ${medianWall}s median of previous ${previous.length}); ${worstStep} grew most (+${round1(Math.max(0, worstGrowth))}s)`,
      next: `Run mainworks bench trial --compare ${refHint} to inspect the regression`,
    };
  }

  return {
    latest,
    median: { count: previous.length, wallSeconds: medianWall, cpuSeconds: medianCpu },
    wallChangePercent,
    cpuChangePercent,
    attention,
  };
}

/** Compares two stored benchmark results (baseline = main, candidate = REF) per step. */
export function compareBenchResults(baseline: BenchResult, candidate: BenchResult): BenchComparison {
  const wallDeltaSeconds = round2(candidate.wallSeconds - baseline.wallSeconds);
  const wallDeltaPercent = baseline.wallSeconds > 0 ? round1((wallDeltaSeconds / baseline.wallSeconds) * 100) : null;
  const cpuDeltaSeconds = round2(candidate.cpuSeconds - baseline.cpuSeconds);
  const cpuDeltaPercent = baseline.cpuSeconds > 0 ? round1((cpuDeltaSeconds / baseline.cpuSeconds) * 100) : null;
  const keys = [...new Set([...Object.keys(baseline.steps), ...Object.keys(candidate.steps)])];
  const steps: Record<string, BenchStepDiff> = {};
  for (const key of keys) {
    const b = baseline.steps[key] ?? 0;
    const c = candidate.steps[key] ?? 0;
    const deltaSeconds = round2(c - b);
    steps[key] = {
      baseline: b,
      candidate: c,
      deltaSeconds,
      deltaPercent: b > 0 ? round1((deltaSeconds / b) * 100) : null,
    };
  }
  return {
    baseline: { commit: baseline.commit, wallSeconds: baseline.wallSeconds, cpuSeconds: baseline.cpuSeconds, outcome: baseline.outcome },
    candidate: { commit: candidate.commit, wallSeconds: candidate.wallSeconds, cpuSeconds: candidate.cpuSeconds, outcome: candidate.outcome },
    wallDeltaSeconds,
    wallDeltaPercent,
    cpuDeltaSeconds,
    cpuDeltaPercent,
    steps,
  };
}

const signedSeconds = (value: number) => `${value >= 0 ? '+' : ''}${value}s`;
const signedPercent = (value: number | null) => value === null ? '' : ` (${value >= 0 ? '+' : ''}${value}%)`;

/** Formats a comparison cleanly for CLI output and quoting in submissions. */
export function formatBenchComparison(comparison: BenchComparison): string {
  const lines = [
    `bench compare ${comparison.candidate.commit.slice(0, 12)} vs ${comparison.baseline.commit.slice(0, 12)}:`,
    `  wall: ${comparison.baseline.wallSeconds}s -> ${comparison.candidate.wallSeconds}s (${signedSeconds(comparison.wallDeltaSeconds)}${signedPercent(comparison.wallDeltaPercent)})`,
    `  cpu:  ${comparison.baseline.cpuSeconds}s -> ${comparison.candidate.cpuSeconds}s (${signedSeconds(comparison.cpuDeltaSeconds)}${signedPercent(comparison.cpuDeltaPercent)})`,
    '  steps:',
  ];
  for (const [step, diff] of Object.entries(comparison.steps)) {
    lines.push(`    ${step}: ${diff.baseline}s -> ${diff.candidate}s (${signedSeconds(diff.deltaSeconds)}${signedPercent(diff.deltaPercent)})`);
  }
  return lines.join('\n');
}

const benchFlights = new WeakMap<DaemonState, Promise<void>>();
const benchAttempts = new WeakMap<DaemonState, { at: number; build: string | null }>();

/**
 * Loop step beside the merge writer and batch gate: runs the reference benchmark once after each
 * deploy of a new build and at most once every 6 hours otherwise, only when no trial is queued.
 * Runs asynchronously beside the cycle and never takes a merge slot.
 */
export function benchStep(cycle: {
  state: DaemonState;
  snapshot: { work: Work[] };
  now: () => number;
  log: (line: string) => void;
  effects: {
    loadedRelease?: { commit: string | null } | null;
    mergeWriter?: { gate?: { root: string } } | null;
  };
}): Promise<void> | null {
  const root = cycle.effects.mergeWriter?.gate?.root;
  if (!root) return null;
  if (!existsSync(join(root, defaultBenchFilesPath))) return null;
  const ledger: Record<string, MergeLedgerState> = Object.fromEntries(
    cycle.snapshot.work.flatMap(item => item.mergeLedger ? [[item.key, item.mergeLedger] as const] : []),
  );
  const trialQueued = mergeQueue(cycle.snapshot.work, ledger, cycle.now()).queue.length > 0
    || !!(cycle.state.mergeWriter.inFlight || cycle.state.mergeWriter.inFlights?.length);
  const currentBuild = readDeployRecord(deployRecordPath(root))?.tip ?? cycle.effects.loadedRelease?.commit ?? null;
  const lastAttempt = benchAttempts.get(cycle.state);
  if (lastAttempt && lastAttempt.build === currentBuild && cycle.now() - lastAttempt.at < benchIntervalMs) {
    return null;
  }
  const results = readBenchResults(benchResultsPath(root));
  const decision = benchDue({ results, currentBuild, now: cycle.now(), trialQueued, inFlight: benchFlights.has(cycle.state) });
  if (!decision.due) return null;

  benchAttempts.set(cycle.state, { at: cycle.now(), build: currentBuild });
  cycle.log(`[graphyard-master] starting trial benchmark (${decision.reason})`);
  const flight = benchTrial({
    root,
    build: currentBuild,
    print: () => {},
  }).then(result => {
    cycle.log(`[graphyard-master] trial benchmark ${result.outcome}: ${result.wallSeconds}s wall, ${result.cpuSeconds}s CPU on ${result.commit.slice(0, 12)}`);
  }, error => {
    cycle.log(`[graphyard-master] trial benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    benchFlights.delete(cycle.state);
  });
  benchFlights.set(cycle.state, flight);
  return flight;
}
