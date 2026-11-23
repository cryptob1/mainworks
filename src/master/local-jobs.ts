// Concern: what is loading this machine (GY-3722): CPU per process between two readings of /proc, summed per job and named by its item and kind.
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gateTrialKey } from '../merge-writer/trial-load.js';

type JobKind = 'builder session' | 'builder test run' | 'merge trial' | 'batch gate' | 'review' | 'other';
export interface LocalJob { item: string | null; kind: JobKind; name?: string; cores: number }
interface Process { ticks: number; cwd: string; command: string }
interface Sample { at: number; processes: Map<string, Process> }

// Linux reports CPU time in clock ticks of 1/100 s.
const ticksPerSecond = 100;
const testRun = /vitest|playwright|run-tests|node:test|--test\b|\bnpm (run )?test|\btsc\b/;

/** Every process's CPU ticks, working directory and command line, keyed by pid and start time. */
function readProcesses(proc: string): Map<string, Process> {
  const processes = new Map<string, Process>();
  for (const pid of readdirSync(proc).filter(name => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(join(proc, pid, 'stat'), 'utf8'), close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      let cwd = '', command = '';
      try { cwd = readlinkSync(join(proc, pid, 'cwd')); } catch { /* another user's process */ }
      try { command = readFileSync(join(proc, pid, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim(); } catch { /* gone */ }
      processes.set(`${pid}:${fields[19]}`, { ticks: Number(fields[11]) + Number(fields[12]), cwd, command: command || stat.slice(stat.indexOf('(') + 1, close) });
    } catch { /* the process ended while read */ }
  }
  return processes;
}

/** A process's job: a builder worktree, or a review or trial checkout (a trial container mounts its checkout at the same path), else other by command. */
function classify(cwd: string, command: string): Omit<LocalJob, 'cores'> {
  const builder = /\/worktrees\/([A-Z][A-Z0-9]*-\d+)-\d+(?:\/|$)/.exec(cwd);
  if (builder) return { item: builder[1]!, kind: testRun.test(command) ? 'builder test run' : 'builder session' };
  const checkout = /\/graphyard-(review|trial|proof|approval)-([a-z0-9-]+?)-[0-9a-f]{7}-[0-9a-f]{8}(?:\/|$)/.exec(cwd);
  if (checkout?.[2] === gateTrialKey) return { item: null, kind: 'batch gate' };
  if (checkout) return { item: checkout[2]!.toUpperCase(), kind: checkout[1] === 'review' ? 'review' : checkout[1] === 'trial' ? 'merge trial' : 'other' };
  return { item: null, kind: 'other', name: basename(command.split(' ')[0] ?? '') || 'unknown' };
}

const previous = new Map<string, Sample>();
/** The five jobs that used the most CPU since the last reading of `proc` (none on the first), in cores. */
export function busiestLocalJobs(proc = '/proc', now = Date.now()): LocalJob[] {
  const before = previous.get(proc), processes = readProcesses(proc);
  previous.set(proc, { at: now, processes });
  if (!before || now <= before.at) return [];
  const jobs = new Map<string, LocalJob>(), seconds = (now - before.at) / 1000;
  for (const [key, process] of processes) {
    const used = process.ticks - (before.processes.get(key)?.ticks ?? 0);
    if (!(used > 0)) continue;
    const job = classify(process.cwd, process.command), id = `${job.item}|${job.kind}|${job.name ?? ''}`;
    const entry = jobs.get(id) ?? { ...job, cores: 0 };
    entry.cores += used / ticksPerSecond / seconds;
    jobs.set(id, entry);
  }
  return [...jobs.values()].sort((a, b) => b.cores - a.cores).slice(0, 5).map(job => ({ ...job, cores: Math.round(job.cores * 10) / 10 }));
}
/** Forget the readings of `proc`: the next reading starts over. */
export const forgetLocalJobs = (proc = '/proc') => previous.delete(proc);

export const localJobsText = (jobs: readonly LocalJob[]) =>
  jobs.map(job => `${job.item ?? 'none'} ${job.kind}${job.name ? ` (${job.name})` : ''} ${job.cores.toFixed(1)} cores`).join(', ');
