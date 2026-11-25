import './helpers/temp-dirs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema } from '../src/master.js';
import { mergeRecordKinds, type MergePorts } from '../src/merge-writer/executor.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-3728: holding an item ends its running merge trial the next cycle and frees its slot for the
// next head; a held item is not trialled again until it is released.

const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
const base = sha('base');
const candidateOf = (key: string) => ({ sha: sha(`head:${key}`), baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' });
const item = (key: string, ageMinutes: number): Work => ({
  id: `w-${key}`, key, title: key, type: 'feature', description: '', priority: 1, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
  policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
  workspaces: [], submission: { epoch: 1, pr: 7 }, candidate: candidateOf(key), reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: { source: 'control-plane', candidate: candidateOf(key), checks: [], reviews: [], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/app.ts'], at: iso(start), baseTip: base } as unknown as Observation,
  blocker: null, gates: ['build', 'review'].map(name => ({ name, passed: true, reasons: [] })), violations: [],
  createdAt: iso(start - ageMinutes * 60_000), updatedAt: iso(start), stageEnteredAt: iso(start - ageMinutes * 60_000),
} as unknown as Work);

/** One trial lane over `work`: `hang`'s trials run until cancelled, every other one passes and delivers. */
function harness(work: Work[], hang: string) {
  const trials: { key: string; signal: AbortSignal | undefined; finished: boolean }[] = [];
  const ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  const fold = () => { const folded = foldMergeLedger(ledgerEvents as never); for (const entry of work) (entry as { mergeLedger?: unknown }).mergeLedger = folded[entry.key] ?? null; };
  const ports: MergePorts = {
    baseBranch: 'main', now: () => start,
    fetch: async () => base,
    merge: async (head, tip) => ({ mergeSha: sha(`merge:${tip}:${head}`), files: ['src/app.ts'] }),
    trial: async (_mergeSha, _files, _item, _baseTip, _onStep, _onTiming, heads, _share, signal) => {
      const trial = { key: heads?.[0]?.key ?? '', signal, finished: false };
      trials.push(trial);
      if (trial.key === hang) await new Promise(() => {});
      trial.finished = true;
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['src/app.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
    },
    push: async () => 'pushed', holds: async () => false,
    record: async (target, event) => {
      const { kind, ...fields } = event as typeof event & { kind: string };
      const payload = kind === 'intent' ? { key: target.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields;
      ledgerEvents.push({ kind: mergeRecordKinds[kind], payload, work: target.key });
      if (kind === 'reconciled') { const landed = work.find(entry => entry.key === target.key)!; landed.stage = 'done'; landed.observation = { ...landed.observation!, merged: true, mergeSha: (event as { mergeSha: string }).mergeSha }; }
      fold();
      return {};
    },
  };
  const reads: MergeWriterReads = { ...ports, parallel: 1, cores: 8 };
  const state = emptyDaemonState(config);
  const effects = { mergeWriter: reads, persist: async () => {}, rework: async () => {} };
  let clock = start;
  const step = async () => { clock += 1000; await mergeWriterStep({ state, effects, now: () => clock, snapshot: { work }, performed: [] } as unknown as Cycle); };
  return { state, trials, step };
}

const hold = (work: Work) => Object.assign(work, { hold: true, holdReason: 'owner paused it', heldBy: 'operator' });
const settle = async (made: ReturnType<typeof harness>) => { for (let cycle = 0; cycle < 6; cycle++) { await made.step(); await mergeWriterIdle(made.state); } };
const inFlight = (made: ReturnType<typeof harness>) => (made.state.mergeWriter.inFlights ?? (made.state.mergeWriter.inFlight ? [made.state.mergeWriter.inFlight] : [])).map(entry => entry.key);

async function heldDuringTrial() {
  const work = [item('GY-1', 30), item('GY-2', 20)];
  const made = harness(work, 'GY-1');
  await made.step();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(made.trials.map(entry => entry.key), ['GY-1'], 'the one lane trials GY-1; GY-2 waits');
  hold(work[0]!);
  await made.step();
  return { work, made };
}

test('integration:hold-cancels-trial — holding an item ends its running trial within one cycle, frees the lane for the next head, and the held head is not trialled again until released', async () => {
  const { work, made } = await heldDuringTrial();
  assert.ok(made.trials[0]!.signal?.aborted, 'the cycle that sees the hold cancels the trial');
  await mergeWriterIdle(made.state);
  await settle(made);
  assert.deepEqual(made.trials.map(entry => entry.key), ['GY-1', 'GY-2'], 'GY-2 takes the freed lane; the held GY-1 is not trialled again');
  assert.deepEqual(work.map(entry => entry.stage), ['build', 'done']);
  assert.deepEqual(inFlight(made), []);
  assert.equal(made.state.mergeWriter.reworks.length, 0, 'a hold refuses nothing to rework');
  // Release puts the head back in the queue; the queue, not the release, starts its trial.
  Object.assign(work[0]!, { hold: false, holdReason: undefined, heldBy: undefined });
  await made.step();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(made.trials.map(entry => entry.key), ['GY-1', 'GY-2', 'GY-1'], 'the released head is queued and trialled again');
});

test('integration:hold-cancels-trial — holding an item with no trial running changes nothing else', async () => {
  const work = [item('GY-1', 30), item('GY-2', 20)];
  hold(work[1]!);
  const made = harness(work, 'none');
  await settle(made);
  assert.deepEqual(made.trials.map(entry => entry.key), ['GY-1'], 'the held head waits out of the queue');
  assert.deepEqual(work.map(entry => entry.stage), ['done', 'build']);
});

test('e2e:hold-cancels-trial — an item held during its merge trial shows no trial in flight in master status, and another item takes the freed slot', async () => {
  const { made } = await heldDuringTrial();
  await mergeWriterIdle(made.state);
  await made.step();
  assert.ok(!inFlight(made).includes('GY-1'), 'master status shows no in-flight trial for the held item');
  await settle(made);
  assert.deepEqual(made.trials.map(entry => entry.key), ['GY-1', 'GY-2'], 'GY-2 took the freed slot');
});
