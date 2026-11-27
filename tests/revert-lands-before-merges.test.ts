import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bootstrapGate, runGate, type GateRecord } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import * as writer from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-4020: on 2026-11-27 the batch gate's revert of GY-4013 retried for over 20 minutes: its leased
// push was rejected each time because merges kept landing on main under it. While the gate holds a
// pending revert, the merge writer now holds its pushes; they resume in queue order once it lands.

const repository = 'owner/project', check = 'test:tests/a.test.ts';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;
const culprit = { id: 'w2', key: 'GY-2', title: 'change', description: 'change', type: 'feature', priority: 2, criteria: [{ id: 'AC-1', text: 'works', proofs: ['unit:works'] }], mergeLedger: null } as unknown as Work;

/** Merges `branch` (one new file) onto `onto` in the pusher and publishes the merge commit as a ref, leaving main unmoved. */
async function queuedMerge(pusher: string, onto: string, branch: string) {
  git(pusher, 'checkout', '-q', '-b', branch, onto);
  await writeFile(join(pusher, `${branch}.ts`), `${branch}\n`);
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', `${branch}: change`);
  git(pusher, 'checkout', '-q', '--detach', onto);
  git(pusher, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}: change`, branch);
  const sha = git(pusher, 'rev-parse', 'HEAD');
  git(pusher, 'push', '-q', 'origin', `${sha}:refs/heads/queued-${branch}`);
  git(pusher, 'checkout', '-q', 'main');
  return sha;
}

test('integration:revert-lands-before-merges — merges that would push while the batch gate has a revert pending wait for it: the revert lands first, then they push in queue order, and status names them', { timeout: 60_000 }, async () => {
  const base = await temporaryDirectory('revert-lands-before-merges'), coordinator = join(base, 'coordinator');
  const { root: pusher, origin } = await gitRepo({ root: join(base, 'pusher'), origin: true, files: { 'graphyard.json': '{}' } });
  const verified = git(pusher, 'rev-parse', 'HEAD');
  git(pusher, 'checkout', '-q', '-b', 'gy-2');
  await writeFile(join(pusher, 'a.ts'), 'broken\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'GY-2: change');
  git(pusher, 'checkout', '-q', 'main');
  git(pusher, 'merge', '-q', '--no-ff', '-m', 'Merge GY-2: change', 'gy-2'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  // Two heads the merge writer trialled on the tip, queued GY-5 then GY-6, each about to push.
  const first = await queuedMerge(pusher, tip, 'GY-5'), second = await queuedMerge(pusher, tip, 'GY-6');
  git(base, 'clone', '-q', origin, coordinator);

  const pushes: { sha: string; result: 'pushed' | 'rejected' }[] = [];
  const state = {}, held: (string[] | null)[] = [];
  let writerPushes: Promise<unknown> = Promise.resolve();
  const reads = {
    baseBranch: 'main', now: Date.now,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args: string[], extra?: Record<string, string>) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    push: async (sha: string, baseTip: string) => {
      let result: 'pushed' | 'rejected' = 'pushed';
      try { execFileSync('git', ['-C', coordinator, 'push', '-q', `--force-with-lease=main:${baseTip}`, 'origin', `${sha}:refs/heads/main`], { env, stdio: 'pipe' }); }
      catch { result = 'rejected'; }
      pushes.push({ sha, result });
      return result;
    },
    // The revert's trial: while it runs, the merge writer's two queued heads reach their push.
    trial: async (_sha: string, _files: readonly string[], _item: unknown, _base?: string, onStep?: (step: string) => void) => {
      onStep?.('install');
      // The base tip exports no shared push: the writer's pushes there go straight to the remote.
      const shared = (writer as { sharedTurns?: (state: object, reads: unknown) => { push: typeof reads.push } }).sharedTurns?.(state, reads) ?? reads;
      const queued = shared.push(first, tip);
      writerPushes = Promise.all([queued, shared.push(second, tip)]);
      await Promise.race([writerPushes, delay(1_500)]);
      held.push(((await import('../src/daemon/gate-revert-hold.js').catch(() => null))?.gatePushHold(state) as { held: string[] } | null)?.held ?? null);
      return passing;
    },
    createWork: async () => ({ key: 'GY-3' }),
  } as unknown as writer.MergeWriterReads & { git: NonNullable<writer.MergeWriterReads['git']> };
  const record: GateRecord = bootstrapGate(repository, verified);
  const ports = { ...batchGatePorts(reads, [culprit], () => null, state), checkpoint: async () => {},
    run: async (commit: string, checks: readonly string[]) => checks.map(entry => entry === 'affected' ? check : entry).filter(entry => entry === check && commit !== verified) };

  const outcome = await runGate(ports, record);
  assert.equal(outcome.outcome, 'reverted', `the revert lands while the merges wait: ${JSON.stringify(outcome)}`);
  const revertSha = (outcome as { revertSha: string }).revertSha;
  assert.equal(git(origin, 'rev-parse', `${revertSha}^`), tip, 'the revert went onto the tip it was trialled on');
  await writerPushes;
  assert.deepEqual(pushes.map(entry => entry.sha), [revertSha, first, second], 'the revert pushed first, then the held merges in queue order');
  assert.deepEqual(pushes[0], { sha: revertSha, result: 'pushed' });
  assert.deepEqual(held, [['Merge GY-5: change', 'Merge GY-6: change']], 'status named both held pushes while the revert was pending');
  const after = await import('../src/daemon/gate-revert-hold.js');
  assert.equal(after.gatePushHold(state), null, 'the hold ends once the revert lands');
  assert.match(git(origin, 'log', '-1', '--format=%s', 'main'), /^Revert "Merge GY-2: change"$/);
});
