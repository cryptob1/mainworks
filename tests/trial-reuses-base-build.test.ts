import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, runMergeTrial, type MergePorts, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { keptBaseBuild, keptBaseBuildMarker } from '../src/merge-writer/trial.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3589: a merge trial's base-tip pass reuses the base tip's kept built tree, so two trials
// against one base commit build that commit once — the second base pass records a reused build
// under 2 s — and a base pass on a newer tip takes the old tip's tree back and builds the new tip once.

const own = 'integration:tests/trial-reuses-base-build.test.ts';
const proof = 'integration:trial-reuses-base-build';
const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
const policy = { mode: 'local', mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fixture' }], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null } };

/** A repository whose proof fails on the base tip (the fix is absent there) and passes on every head (each adds it). */
async function repository() {
  const root = await temporaryDirectory('base-build-repo', tmpdir());
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  gitIn(root, 'init', '-q', '-b', 'main');
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'true', test: 'node test.js' } }));
  write('graphyard.json', JSON.stringify({ delivery: policy }));
  write('test.js', `const { existsSync } = require('node:fs');\nconst ok = existsSync('src/fixed');\nconsole.log((ok ? 'ok' : 'not ok') + ' 1 - ${proof} the fix holds');\nprocess.exit(ok ? 0 : 1);\n`);
  gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', 'base');
  let base = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'checkout', '-q', '--detach');
  return {
    get root() { return root; },
    get base() { return base; },
    /** A head on the current base that adds the fix plus its own file; main itself stays at the base. */
    head: (name: string) => {
      gitIn(root, 'checkout', '-q', '--detach', base);
      write(`src/${name}`, '');
      write('src/fixed', '');
      gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', name);
      const sha = gitIn(root, 'rev-parse', 'HEAD');
      gitIn(root, 'checkout', '-q', 'main');
      return sha;
    },
    /** Moves main one commit forward (the fix still absent) and answers the new tip. */
    advance: (name: string) => {
      gitIn(root, 'checkout', '-q', 'main');
      write(`src/moved-${name}`, '');
      gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', `moved ${name}`);
      base = gitIn(root, 'rev-parse', 'HEAD');
      gitIn(root, 'checkout', '-q', '--detach');
      return name;
    },
  };
}

// These trusted fixtures run real checks locally; container isolation is covered separately.
// npm's install and build are stood in for, and each build names the tree it ran in.
const builds: string[] = [];
const run: ChildRun = async (command, args, options) => {
  options = { ...options, wrapper: undefined };
  if (command === 'git') return defaultChildRun(command, args, { ...options, env: { ...process.env, ...identity, ...options?.env } });
  if (command !== 'npm') return defaultChildRun(command, args, options);
  if (args[0] === 'run' && args[1] === 'build') { builds.push(options?.cwd ?? ''); return ''; }
  if (args[0] === 'test' || (args[0] === 'run' && args[1] === 'test')) {
    try { return await defaultChildRun('node', ['test.js'], options); }
    catch (error) { throw Object.assign(new Error('Command failed: npm run test'), { status: 1, signal: null, stdout: (error as { stdout?: string }).stdout ?? '', stderr: '' }); }
  }
  return '';
};

type TrialEvent = Extract<MergeRecordEvent, { kind: 'trial'; outcome: 'verdict' }> & { proofs?: Record<string, { executed: number; failed: number }> };
interface Merged { outcome: Awaited<ReturnType<typeof mergeOne>>; trial: TrialEvent | undefined; steps: string[]; timings: [string, number][] }

/** One item merged through the trial runner: a caching trial (the merge writer's own) when `reuse`, else one that caches nothing. */
async function merge(repo: { root: string; base: string }, key: string, head: string, options: { baseRoot: string; reuse: boolean }): Promise<Merged> {
  const events: MergeRecordEvent[] = [], steps: string[] = [], timings: [string, number][] = [];
  const reads = mergeWriterReads(config, repo.root, run, { base: options.baseRoot, record: async () => {}, environment: { PATH: process.env.PATH! },
    ...(options.reuse ? {} : { trial: (input: Parameters<typeof runMergeTrial>[0]) => runMergeTrial({ ...input, caches: false }) }) });
  const ports: MergePorts = { baseBranch: 'main', now: () => Date.parse('2030-01-01T00:00:00Z'), fetch: async () => repo.base, merge: reads.merge,
    trial: (sha, files, item, baseTip, onStep, onTiming, heads, share, signal, timeoutMs) => reads.trial(sha, files, item, baseTip,
      (step: string) => { steps.push(step); onStep?.(step); }, (step: string, durationMs: number) => { timings.push([step, durationMs]); onTiming?.(step, durationMs); }, heads, share, signal, timeoutMs),
    push: async () => 'pushed', holds: async () => false, record: async (_work, event) => { events.push(event); } };
  const work = { id: `w-3589-${key}`, key, type: 'bug', title: 'fix', candidate: { sha: head, baseSha: repo.base, pr: 1, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' },
    submission: { epoch: 1, pr: 1 }, criteria: [{ id: 'AC-1', text: 'the fix holds', proofs: [proof] }] } as unknown as Work;
  return { outcome: await mergeOne(ports, work), trial: events.find(event => event.kind === 'trial') as TrialEvent | undefined, steps, timings };
}

test(`${own} — two trials on one base commit build the tip once, the second base pass recording a reused build under 2 s; a moved base takes the old tip's tree back and builds the new tip once`, { timeout: 300_000 }, async () => {
  const repo = await repository();
  const headA = repo.head('a'), headB = repo.head('b');

  // The same two heads without reuse: what the trials must keep answering.
  const plainRoot = await temporaryDirectory('base-build-plain', tmpdir());
  const plainA = await merge(repo, 'GY-3589-A', headA, { baseRoot: plainRoot, reuse: false });
  const plainB = await merge(repo, 'GY-3589-B', headB, { baseRoot: plainRoot, reuse: false });
  for (const plain of [plainA, plainB]) {
    assert.equal(plain.outcome.outcome, 'merged', JSON.stringify(plain.outcome));
    assert.deepEqual(plain.trial?.proofs?.[proof], { executed: 1, failed: 0 });
  }

  const reuseRoot = await temporaryDirectory('base-build-trials', tmpdir());
  const kept1 = keptBaseBuild(reuseRoot, repo.base);
  const first = await merge(repo, 'GY-3589-C', headA, { baseRoot: reuseRoot, reuse: true });
  const second = await merge(repo, 'GY-3589-D', headB, { baseRoot: reuseRoot, reuse: true });

  // AC-1: both verdicts match the run without reuse, and the base tip's build ran once.
  assert.equal(first.outcome.outcome, 'merged', JSON.stringify(first.outcome));
  assert.equal(second.outcome.outcome, 'merged', JSON.stringify(second.outcome));
  for (const [reuse, plain] of [[first, plainA], [second, plainB]] as const) {
    const verdict = ({ build, tests, proofs }: TrialEvent) => ({ build, tests, proofs });
    assert.deepEqual(verdict(reuse.trial!), verdict(plain.trial!), 'the verdict matches the run without reuse');
  }
  assert.ok(existsSync(kept1) && existsSync(keptBaseBuildMarker(kept1)), 'the tip\'s built tree stays kept');
  assert.equal(builds.filter(cwd => cwd === kept1).length, 1, `the base tip's build ran once: ${JSON.stringify(builds)}`);
  assert.ok(!first.steps.includes('build: reused'), 'the first trial built the base tip itself');
  const reused = second.timings.find(([step]) => step === 'build: reused');
  assert.ok(reused, `the second trial's base pass records a reused build step: ${JSON.stringify(second.steps)}`);
  assert.ok(reused[1] < 2000, `the reused build step took ${reused[1]} ms of wall time`);

  // AC-2: main moves — the old tip's kept build goes, the new tip is built once.
  repo.advance('one');
  const headC = repo.head('c');
  const kept2 = keptBaseBuild(reuseRoot, repo.base);
  const third = await merge(repo, 'GY-3589-E', headC, { baseRoot: reuseRoot, reuse: true });
  assert.equal(third.outcome.outcome, 'merged', JSON.stringify(third.outcome));
  assert.ok(!existsSync(kept1) && !existsSync(keptBaseBuildMarker(kept1)), 'the moved-past tip\'s kept build went');
  assert.ok(existsSync(kept2) && existsSync(keptBaseBuildMarker(kept2)), 'the new tip\'s built tree is kept');
  assert.equal(builds.filter(cwd => cwd === kept2).length, 1, 'the new tip\'s build ran once');
  assert.equal(builds.filter(cwd => cwd === kept1).length, 1, 'and the old tip still exactly once');
});
