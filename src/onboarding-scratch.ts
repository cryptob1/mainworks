// Concern: the scratch install the daily onboarding time runs in (GY-3747); src/onboarding-time.ts
// holds the run's record and the host side that starts it in a checkout of the verified commit.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { defaultChildRun } from './child-runner.js';
import { mergeWriterReads } from './daemon/cycle-merge-writer.js';
import { firstTaskInput, type FirstRunIssue } from './model/first-run.js';
import { loopPresenceHeader } from './model/loop-presence.js';
import { proposedRuntimes } from './model/registry.js';
import { repositoryPolicy, setRepositoryPolicy } from './model-boundary/repository-policy.js';
import { gitRunnerFor } from './merge-writer/local-observation.js';
import type { OnboardingRun } from './onboarding-time.js';
import { server } from './server.js';
import { lockedWork } from './store/locked-read.js';
import { save } from './store/store.js';
import type { Store } from './store.js';

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
  const origin = join(input.scratch, 'origin.git');
  git('init', '-q', '--bare', '-b', 'main', origin);
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  const writer = mergeWriterReads({ repository: 'fixture/onboarding', baseBranch: 'main', run: { mergeWriter: { deployKeyFile: join(input.scratch, 'unused-local-key') } } }, repo, defaultChildRun,
    { base: input.scratch, record: async () => {} });

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

  let pushedAt: number | undefined;
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
      const baseTip = await writer.fetch();
      const merged = await writer.merge(git('rev-parse', branch()), baseTip);
      if ('conflict' in merged) throw new Error('The first change conflicts with main');
      const { mergeSha } = merged;
      if (await writer.push(mergeSha, baseTip) !== 'pushed') throw new Error('The first merge push was rejected');
      pushedAt = now();
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
  const ended = pushedAt ?? now(), seconds = (ended - started) / 1000;
  // Round up to tenths: a real sub-three-second run must not read as zero minutes.
  return { at: new Date(ended).toISOString(), commit: input.commit, seconds, minutes: Math.ceil(seconds / 6) / 10, result: handFixes.length ? 'failed' : 'passed', handFixes };
}
