import './helpers/temp-dirs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { emptyDaemonState } from '../src/daemon/state.js';
import { mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { TrialRunRequest } from '../src/merge-writer/trial-run.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3921: a trial's time limit follows the configured trials at once, never what else happens to be
// running when it starts: at parallelism 2, a trial launched alone and one launched beside it get the same limit.

const start = Date.parse('2030-09-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');
const due = (n: number): Work => {
  const candidate = { sha: sha(`head${n}`), baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
  return workFixture({ id: `w${n}`, key: `GY-${n}`, stage: 'build', epoch: 1, submission: { epoch: 1, pr: n }, candidate, createdAt: iso(start + n * 1000), stageEnteredAt: iso(start + n * 1000),
    observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: base, baseTipContained: true, at: iso(start) },
    gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })) } as never);
};

test('unit:trial-limit-does-not-depend-on-what-else-runs — at parallelism 2 a trial launched alone and one launched beside it get equal limits', { timeout: 30_000 }, async () => {
  const launched: TrialRunRequest[] = [];
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => start, parallel: 2, cores: 24,
    fetch: async () => base,
    merge: async (head, tip) => ({ mergeSha: sha(`merge:${head}:${tip}`), files: ['src/item.ts'] }),
    trial: async () => { throw new Error('these reads launch detached trial runs only'); },
    push: async () => 'pushed', holds: async () => false, record: async () => {},
    launchTrialRun: spec => {
      launched.push(spec);
      // The run never reaches a verdict here: the first stays in flight while the second starts.
      return { directory: `/runs/${spec.key}`, mergeSha: spec.mergeSha, trial: () => new Promise<MergeTrialRun>(() => {}), detach: () => {}, cancel: () => {} };
    },
  };
  const state = emptyDaemonState(config);
  let clock = start;
  const cycle = async (work: Work[]) => { clock += 60_000; await mergeWriterStep({ state, effects: { mergeWriter: reads, persist: async () => {}, rework: async () => {} }, now: () => clock, snapshot: { work, now: iso(clock) }, performed: [] } as unknown as Cycle); };
  const waitFor = async (count: number) => { for (let waited = 0; launched.length < count && waited < 5_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5)); };

  await cycle([due(1)]);
  await waitFor(1);
  await cycle([due(1), due(2)]);
  await waitFor(2);
  assert.deepEqual(launched.map(spec => spec.key), ['GY-1', 'GY-2'], 'GY-1 starts alone, GY-2 beside it');
  assert.equal(launched[1]!.timeoutMs, launched[0]!.timeoutMs, 'the limit is the same alone and beside another trial');
});
