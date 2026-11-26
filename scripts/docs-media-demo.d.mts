import type { Work } from '../src/model';

export const NOW: number;
export function at(offset: number): string;
export function buildDemoState(phase?: 'static' | 'before-create' | 'build' | 'review' | 'test' | 'merged' | 'live' | 'setup'): {
  work: Work[];
  board: { groups: Record<string, { key: string }[]> };
  status: { checksRunning: number; setup: { panes: { master: string } | null } } & Record<string, unknown>;
} & Record<string, unknown>;
