// GY-3750: how many of the reachable test files each item's trial selected, for master status.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { stateDirectory } from '../install/layout.js';

export interface TestSelection { at: string; selected: number; reachable: number; /** GY-3787: every test file of the commit; absent on a trial recorded before it. */ all?: number }
const path = (root: string) => join(stateDirectory(root), 'test-selections.json');
const kept = 20;

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
export function testSelectionSummary(runs: readonly TestSelection[]) {
  const median = (whole: 'reachable' | 'all') => {
    const shares = runs.flatMap(run => run[whole] ? [run.selected / run[whole]] : []).sort((a, b) => a - b);
    return shares.length ? `${Math.round(shares[Math.floor((shares.length - 1) / 2)]! * 100)}%` : null;
  };
  const medianShareSelected = median('reachable');
  return medianShareSelected && { trials: runs.filter(run => run.reachable > 0).length, medianShareSelected, medianShareOfAllSelected: median('all') };
}
