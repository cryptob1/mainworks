// GY-3838: each merge trial's and release check's per-file test durations, the last 20 kept, so master
// status and the planner name the five slowest trial test files by their median over those trials.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { stateDirectory } from '../install/layout.js';

export interface TrialTimings { at: string; run: 'merge trial' | 'release check'; commit: string; /** Milliseconds each test file ran, by file. */ files: Record<string, number> }
const path = (root: string) => join(stateDirectory(root), 'trial-timings.json');
const kept = 20;

export function readTrialTimings(root: string): TrialTimings[] {
  try { const runs = JSON.parse(readFileSync(path(root), 'utf8')); return Array.isArray(runs) ? runs : []; } catch { return []; }
}

export async function recordTrialTimings(root: string, timings: TrialTimings): Promise<void> {
  const file = path(root), runs = [...readTrialTimings(root), timings].slice(-kept);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(temporary, `${JSON.stringify(runs)}\n`);
  await rename(temporary, file);
}

/** The five slowest test files over the stored trials, by the median of the seconds each ran in the trials that ran it. */
export function slowestTrialFiles(runs: readonly TrialTimings[], count = 5): { file: string; medianSeconds: number }[] {
  const byFile = new Map<string, number[]>();
  for (const run of runs) for (const [file, ms] of Object.entries(run.files)) byFile.set(file, [...byFile.get(file) ?? [], ms]);
  return [...byFile].map(([file, all]) => {
    const sorted = all.sort((a, b) => a - b), middle = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return { file, medianSeconds: Math.round(median / 100) / 10 };
  }).sort((a, b) => b.medianSeconds - a.medianSeconds || a.file.localeCompare(b.file)).slice(0, count);
}
