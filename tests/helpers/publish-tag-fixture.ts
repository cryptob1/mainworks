import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batchGateStep } from '../../src/daemon/cycle-batch-gate.js';
import { mergeWriterReads, type MergeWriterReads } from '../../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../../src/daemon/state.js';
import { deployRecordPath } from '../../src/deploy-watch.js';
import type { MergeTrialRun } from '../../src/merge-writer/executor.js';
import type { Work } from '../../src/model.js';
import { mainworksRepository } from '../../src/scenarios.js';
import { temporaryDirectory } from './temp-dirs.js';

const gitIdentity = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const runGit = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitIdentity, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Mainworks's own coordinator checkout over a scratch origin, a trial that always passes, and `merge()` to land one more item on main. */
export async function gateFixture(repository = mainworksRepository, pushReleaseTag?: MergeWriterReads['pushReleaseTag']) {
  const base = await temporaryDirectory('publish-verified-gate');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  runGit(base, ['init', '-q', '--bare', '-b', 'main', origin]);
  runGit(base, ['clone', '-q', origin, pusher]);
  await mkdir(join(pusher, 'e2e', 'cases'), { recursive: true });
  await writeFile(join(pusher, 'graphyard.json'), JSON.stringify({ gate: { core: ['smoke'] } }));
  await writeFile(join(pusher, 'e2e', 'cases', 'smoke.json'), '{}');
  runGit(pusher, ['add', '.']); runGit(pusher, ['commit', '-q', '-m', 'base']); runGit(pusher, ['push', '-q', 'origin', 'HEAD:main']);
  runGit(base, ['clone', '-q', origin, coordinator]);
  const work: Work[] = [];
  const merge = async () => {
    const n = work.length + 1;
    runGit(pusher, ['checkout', '-q', '-b', `item-${n}`]);
    await writeFile(join(pusher, `f${n}.txt`), 'ok\n');
    runGit(pusher, ['add', '.']); runGit(pusher, ['commit', '-q', '-m', `change ${n}`]); runGit(pusher, ['checkout', '-q', 'main']);
    runGit(pusher, ['merge', '-q', '--no-ff', '-m', `Merge GY-${n}: change ${n}`, `item-${n}`]); runGit(pusher, ['push', '-q', 'origin', 'HEAD:main']);
    work.push({ id: `work-${n}`, key: `GY-${n}`, title: `change ${n}`, description: '', type: 'feature', priority: 2, criteria: [{ id: 'AC-1', text: 'works', proofs: ['e2e:smoke'] }], mergeLedger: null } as unknown as Work);
    return runGit(pusher, ['rev-parse', 'HEAD']);
  };
  const run = (...args: string[]) => runGit(coordinator, args);
  const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const deployKey = join(base, 'deploy-key');
  const production = mergeWriterReads({ repository, baseBranch: 'main', run: { mergeWriter: { deployKeyFile: deployKey } } } as any, coordinator,
    (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      assert.equal(command, 'git', 'the host may run only git, never npm or docker');
      return execFileSync(command, args, { encoding: 'utf8', env: options?.env ?? gitIdentity, stdio: ['ignore', 'pipe', 'pipe'] });
    }, { base, record: async () => undefined, environment: gitIdentity });
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: Date.now,
    fetch: async () => { run('fetch', '-q', 'origin', 'main'); return run('rev-parse', 'origin/main'); },
    git: async args => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: gitIdentity }),
    merge: async () => { throw new Error('unused'); },
    trial: async (_commit, _files, item) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
      e2e: item.criteria.flatMap(criterion => criterion.proofs).map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) }) as unknown as MergeTrialRun,
    push: async () => 'pushed', holds: async () => true, record: async () => undefined, createWork: async () => null,
    gate: { root: coordinator, repository },
    pushReleaseTag: pushReleaseTag ?? production.pushReleaseTag,
  };
  let state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any), lines: string[] = [];
  const cycle = () => ({ state, effects: { mergeWriter: reads } as any, snapshot: { work, now: new Date().toISOString() } as any, now: Date.now, log: (line: string) => lines.push(line) });
  /** Run both gate flights to their end, then observe the persisted handoff on another cycle. */
  const gate = async () => {
    const first = await batchGateStep(cycle());
    await first!.gate; await first!.diagnostics;
    const next = await batchGateStep(cycle());
    await next!.gate; await next!.diagnostics; await next!.tag;
  };
  const deploy = async (tip: string, extra = {}) => writeFile(deployRecordPath(coordinator), JSON.stringify({ repository, tip, failed: null, reason: null, at: new Date().toISOString(), ...extra }));
  const restart = () => { state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as any); };
  return { coordinator, origin, merge, gate, deploy, restart, calls, deployKey, lines, cycle };
}
