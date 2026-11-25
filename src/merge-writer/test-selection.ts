// GY-3750: how many of the reachable test files each item's trial selected, for master status.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { stateDirectory } from '../install/layout.js';

export interface TestSelection { at: string; selected: number; reachable: number; /** GY-3787: every test file of the commit; absent on a trial recorded before it. */ all?: number;
  /** GY-3840: the item the trial was for and the test files it selected; absent on a trial recorded before it. */ key?: string; files?: string[] }
const path = (root: string) => join(stateDirectory(root), 'test-selections.json');
/** GY-3840: enough trials to cover the items of the last 20 release checks; the share line reads the last 20. */
const kept = 100;

/** The counts a selection's reason line states (`selected 84 of 412 reachable`), or null. */
export const selectionCounts = (line: string) => {
  const match = /\bselected (\d+) of (\d+) reachable\b/.exec(line);
  return match ? { selected: Number(match[1]), reachable: Number(match[2]) } : null;
};

export function readTestSelections(root: string): TestSelection[] {
  try { const runs = JSON.parse(readFileSync(path(root), 'utf8')); return Array.isArray(runs) ? runs : []; } catch { return []; }
}

export async function recordTestSelection(root: string, counts: Omit<TestSelection, 'at'>): Promise<void> {
  const file = path(root), runs = [...readTestSelections(root), { at: new Date().toISOString(), ...counts }].slice(-kept);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(temporary, `${JSON.stringify(runs)}\n`);
  await rename(temporary, file);
}

/** Master status's line: over the last 20 item trials, the median share of reachable test files selected, and of all test files. */
export function testSelectionSummary(all: readonly TestSelection[]) {
  const runs = all.slice(-20);
  const median = (whole: 'reachable' | 'all') => {
    const shares = runs.flatMap(run => run[whole] ? [run.selected / run[whole]] : []).sort((a, b) => a - b);
    return shares.length ? `${Math.round(shares[Math.floor((shares.length - 1) / 2)]! * 100)}%` : null;
  };
  const medianShareSelected = median('reachable');
  return medianShareSelected && { trials: runs.filter(run => run.reachable > 0).length, medianShareSelected, medianShareOfAllSelected: median('all') };
}

/** GY-3840: a release check's items and the test files it caught failing (that failed again and pass on the verified commit). */
export interface ReleaseSweep { at: string; /** The batch tip the check ran on. */ tip?: string; items: string[]; failed: string[] }

/**
 * Over the last 20 release checks, the failing test files no recorded item trial of the batch selected,
 * with the latest one's file and item. A batch item with no recorded trial may have run every test, so
 * a file in its batch is never counted.
 */
export function missedByNarrowing(sweeps: readonly ReleaseSweep[], runs: readonly TestSelection[]) {
  const checks = sweeps.slice(-20);
  const missed = checks.flatMap(sweep => {
    const trials = sweep.items.map(item => runs.filter(run => run.key === item && run.files));
    if (trials.some(item => !item.length)) return [];
    const selected = new Set(trials.flat().flatMap(run => run.files!));
    return sweep.failed.filter(file => !selected.has(file)).map(file => ({ file, item: sweep.items.join(', '), at: sweep.at }));
  });
  return { releaseChecks: checks.length, missed: missed.length, latest: missed.at(-1) ?? null };
}
