// Concern: the daily onboarding time (GY-3747). A scratch install of the verified commit connects a
// small fixture repository, starts its first task the way the first-run page does, and a stub
// Builder carries it to a merge; the run records the minutes from connect to first merge and every
// step that refused, which a person would have had to fix by hand. Never the live install: the
// task it files would reach real workers.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultChildRun } from './child-runner.js';
import { Engine } from './engine.js';
import { firstTaskInput, type FirstRunIssue } from './model/first-run.js';
import { loopPresenceHeader } from './model/loop-presence.js';
import { proposedRuntimes } from './model/registry.js';
import { repositoryPolicy, setRepositoryPolicy } from './model-boundary/repository-policy.js';
import { gitRunnerFor } from './merge-writer/local-observation.js';
import { server } from './server.js';
import { lockedWork } from './store/locked-read.js';
import { save } from './store/store.js';
import type { Store } from './store.js';

/** The E2E case whose presence in a repository's catalog makes its daily diagnostics time onboarding. */
export const onboardingCase = 'onboarding-time-measured';

/** The brief's bound: a first merge slower than this files an item. */
export const onboardingLimitMinutes = 15;

/** One daily onboarding run: minutes from connect to first merge, and each step that needed a hand fix. */
export interface OnboardingRun { at: string; commit: string; minutes: number; result: 'passed' | 'failed'; handFixes: string[] }

/** Why a run files an item — a hand fix or a first merge over the limit — or null when it needs none. */
export function onboardingFailure(run: OnboardingRun): string | null {
  if (run.handFixes.length) return `the first merge needed a hand fix: ${run.handFixes.join('; ')}`;
  return run.minutes > onboardingLimitMinutes ? `the first merge took ${run.minutes} minutes, over ${onboardingLimitMinutes}` : null;
}

const issue: FirstRunIssue = { number: 1, title: 'Show the version number in the footer', body: 'The footer should say which version runs.', labels: ['small'], url: 'https://github.com/fixture/onboarding/issues/1' };

/** The run itself, on `store` (a fresh scratch database), with its fixture repository under `scratch`. */
export async function measureOnboarding(store: Store, input: { scratch: string; commit: string; now?: () => number }): Promise<OnboardingRun> {
  const now = input.now ?? Date.now, repo = join(input.scratch, 'fixture');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const tokens = { admin: `admin-${randomUUID()}`, builder: `builder-${randomUUID()}`, loop: `loop-${randomUUID()}` };
  await mkdir(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Stub Builder'); git('config', 'user.email', 'builder@example.invalid');
  await writeFile(join(repo, 'README.md'), '# Onboarding fixture\n');
  git('add', 'README.md'); git('commit', '-q', '-m', 'Initial commit');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));

  const policy = repositoryPolicy();
  setRepositoryPolicy({ ...policy, e2e: { ...policy.e2e, pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
  const engine = new Engine(store, 120, 'fixture/onboarding');
  engine.gitRunner = gitRunnerFor(repo);
  engine.baseBranch = 'main';
  const http = server(engine, [
    { id: 'owner', displayName: 'Owner', role: 'admin', sessionKind: 'human', token: tokens.admin },
    { id: 'builder-stub', role: 'worker', sessionKind: 'ai', token: tokens.builder },
    { id: 'loop', role: 'coordinator', sessionKind: 'ai', token: tokens.loop },
  ]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const api = async (path: string, token: string, data?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST', body: data === undefined ? undefined : JSON.stringify(data),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error ?? `${path} answered ${response.status}`);
    return body;
  };

  let task: { id: string; key: string; revision: number } | null = null, epoch = 0;
  const branch = () => `graphyard/${task!.key.toLowerCase()}-1`;
  const steps: [string, () => Promise<unknown>][] = [
    ['connect the repository', async () => {
      await api('work-snapshot', tokens.loop, undefined, { [loopPresenceHeader]: '5' });
      await api('first-run/issues', tokens.loop, { issues: [issue] });
    }],
    ['connect the Builder', async () => {
      await api('agent-registry/apply', tokens.admin, { runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')!], models: [{ name: 'opus', id: 'claude-opus-5-5' }],
        accounts: [{ name: 'builder-stub', runtime: 'claude', model: 'opus', credential: { host: 'scratch', home: join(input.scratch, 'builder') } }],
        roles: [{ name: 'worker', accounts: ['builder-stub'], concurrency: 1 }], reason: 'Onboarding diagnostic Builder' });
      await api('agent-registry/observe', tokens.loop, { host: 'scratch', observations: [{ account: 'builder-stub',
        quota: { loggedIn: true, state: 'available', usage: [], resetsAt: null, reason: null, since: new Date(now()).toISOString() }, smoke: { result: 'pass', reason: null } }] });
    }],
    // As the first-run page's Start: the offered issue becomes a task, released for the Builder.
    ['start the first task', async () => {
      const offered = (await api('first-run/issues', tokens.admin)).issues as FirstRunIssue[];
      if (!offered.length) throw new Error('first run offered no issue');
      task = await api('work', tokens.admin, firstTaskInput(offered[0]!));
      await api(`work/${task!.id}/ready`, tokens.admin, { expectedRevision: task!.revision, reason: 'First task, started from the first-run page' });
    }],
    ['the Builder submits', async () => {
      epoch = (await api(`work/${task!.id}/claim`, tokens.builder, {})).epoch;
      await api(`work/${task!.id}/workspace`, tokens.builder, { epoch, host: 'scratch', path: join(input.scratch, task!.key), branch: branch() });
      git('checkout', '-q', '-b', branch());
      await writeFile(join(repo, 'footer.txt'), 'v1.0.0\n');
      git('add', 'footer.txt'); git('commit', '-q', '-m', 'Show the version number in the footer');
      await api(`work/${task!.id}/submit`, tokens.builder, { epoch, head: git('rev-parse', 'HEAD') });
    }],
    ['merge the first change', async () => {
      git('checkout', '-q', 'main');
      git('merge', '-q', '--no-ff', '-m', `Merge ${task!.key}`, branch());
      const mergeSha = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/main', mergeSha);
      await store.transaction(async (db, at) => {
        const work = (await lockedWork(db, [task!.id]))[0]!;
        work.stage = 'done'; work.lease = null;
        work.delivery = { mergedAt: at.toISOString(), mergeSha, authorizationRevision: work.policyRevision };
        await save(db, work, 'loop', 'merge-writer.reconciled', at);
      });
    }],
  ];

  const started = now(), handFixes: string[] = [];
  try {
    for (const [name, step] of steps) {
      try { await step(); } catch (error) { handFixes.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); break; }
    }
  } finally {
    setRepositoryPolicy(policy);
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
  return { at: new Date(now()).toISOString(), commit: input.commit, minutes: Math.round((now() - started) / 6_000) / 10, result: handFixes.length ? 'failed' : 'passed', handFixes };
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
