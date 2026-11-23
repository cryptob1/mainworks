// Concern: the daily onboarding time (GY-3747). A scratch install of the verified commit connects a
// small fixture repository, starts its first task the way the first-run page does, and a stub
// Builder carries it to a merge; the run records the minutes from connect to first merge and every
// step that refused, which a person would have had to fix by hand. Never the live install: the
// task it files would reach real workers. The run itself is src/onboarding-scratch.ts, kept apart so
// the batch gate's record reads none of the engine.
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChildRun } from './child-runner.js';

/** The E2E case whose presence in a repository's catalog makes its daily diagnostics time onboarding. */
export const onboardingCase = 'onboarding-time-measured';

/** The brief's bound: a first merge slower than this files an item. */
const onboardingLimitMinutes = 15;

/** One daily onboarding run: minutes from connect to first merge, and each step that needed a hand fix. */
export interface OnboardingRun { at: string; commit: string; minutes: number; result: 'passed' | 'failed'; handFixes: string[] }

/** Why a run files an item — a hand fix or a first merge over the limit — or null when it needs none. */
export function onboardingFailure(run: OnboardingRun): string | null {
  if (run.handFixes.length) return `the first merge needed a hand fix: ${run.handFixes.join('; ')}`;
  return run.minutes > onboardingLimitMinutes ? `the first merge took ${run.minutes} minutes, over ${onboardingLimitMinutes}` : null;
}

/** The run on `commit`, checked out from `root`, by that commit's own scripts/onboarding-time.ts in a scratch install; never throws. */
export async function runOnboardingTime(input: { root: string; commit: string }): Promise<OnboardingRun> {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-onboarding-')), worktree = join(directory, 'checkout');
  const git = (...args: string[]) => defaultChildRun('git', ['-C', input.root, ...args]);
  try {
    await git('worktree', 'add', '--detach', worktree, input.commit);
    if (existsSync(join(input.root, 'node_modules'))) await symlink(join(input.root, 'node_modules'), join(worktree, 'node_modules'));
    const output = await defaultChildRun(process.execPath, ['--import', import.meta.resolve('tsx'), 'scripts/onboarding-time.ts', input.commit],
      { cwd: worktree, env: { ...process.env, TMPDIR: directory }, timeoutMs: 30 * 60_000 });
    return JSON.parse(output.trim().split('\n').at(-1)!) as OnboardingRun;
  } catch (error) {
    return { at: new Date().toISOString(), commit: input.commit, minutes: 0, result: 'failed', handFixes: [`run the scratch install: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`] };
  } finally {
    await git('worktree', 'remove', '--force', worktree).catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
