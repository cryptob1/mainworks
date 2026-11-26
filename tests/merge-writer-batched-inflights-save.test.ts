import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { emptyDaemonState, writeDaemonState, readDaemonState } from '../src/daemon/state.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeRecordKinds, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { maxMergeWriterParallel } from '../src/master/merge-writer-settings.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Work } from '../src/model.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3672: with every trial slot taken by a batch of compatible heads (GY-3625), the merge writer holds
// more in-flight heads than the parallel limit; its state must still save on every cycle, one entry per head.

const start = Date.parse('2030-09-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const pass: MergeTrialRun = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };

test('integration:merge-writer-batched-inflights-save — parallel limit full of batched trials: the state saves every cycle with one in-flight entry per head, and every head merges', { timeout: 60_000 }, async () => {
  const directory = await temporaryDirectory('batched-inflights-save');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(directory, 'coordinator.token'), cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  const count = maxMergeWriterParallel * 4, base = sha('base'), main = [base], events: { kind: string; payload: unknown; work: string }[] = [];
  const held: (() => void)[] = [];
  const snapshot = (): Work[] => {
    const folded = foldMergeLedger(events as never);
    return Array.from({ length: count }, (_, index) => index + 1).map(n => {
      const ledger = folded[`GY-${n}`] ?? null, delivered = ledger?.state === 'reconciled';
      const candidate = { sha: sha(`head${n}`), baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return workFixture({ id: `w${n}`, key: `GY-${n}`, title: `Item ${n}`, priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
        createdAt: iso(start + n * 1000), updatedAt: iso(start), stageEnteredAt: iso(start + n * 1000), epoch: 1, submission: { epoch: 1, pr: n }, candidate, mergeLedger: ledger, systemDriven: undefined,
        observation: { source: 'control-plane', candidate, files: [`item-${n}.txt`], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: main[0], baseTipContained: true, at: iso(start) },
        gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt!, mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as never);
    });
  };
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => start, parallel: maxMergeWriterParallel, cores: 64, memory: async () => null,
    fetch: async () => main[0]!,
    merge: async (head, tip) => ({ mergeSha: sha(`merge:${head}:${tip}`), files: ['item.txt'] }),
    // Every batch's trial waits until released, so all slots are full at once.
    trial: () => new Promise(resolve => held.push(() => resolve(pass))),
    push: async mergeSha => { main.unshift(mergeSha); return 'pushed'; },
    holds: async commit => main.includes(commit),
    record: async (item, event: MergeRecordEvent) => {
      const { kind, ...fields } = event as typeof event & { kind: string };
      events.push({ kind: mergeRecordKinds[kind], work: item.key, payload: kind === 'intent' ? { key: item.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields });
    },
  };
  const state = emptyDaemonState(config), saves: Promise<void>[] = [], failures: unknown[] = [];
  const persist = () => { const saved = writeDaemonState(config, state).catch(error => { failures.push(error); throw error; }); saves.push(saved.catch(() => {})); return saved; };
  let clock = start;
  const cycle = async () => { clock += 60_000; await mergeWriterStep({ state, effects: { mergeWriter: reads, persist, rework: async () => {} }, now: () => clock, snapshot: { work: snapshot(), now: iso(clock) }, performed: [] } as unknown as Cycle); await persist(); };

  await cycle();
  for (let waited = 0; held.length < maxMergeWriterParallel && waited < 5_000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(held.length, maxMergeWriterParallel, 'every trial slot runs one batch');
  const inFlights = state.mergeWriter.inFlights ?? [];
  assert.ok(inFlights.length > maxMergeWriterParallel, `${inFlights.length} heads in flight`);
  assert.deepEqual(inFlights.map(entry => entry.key), Array.from({ length: count }, (_, index) => `GY-${index + 1}`), 'each head keeps its own in-flight entry');
  await cycle();
  await Promise.all(saves);
  assert.deepEqual(failures.map(String), [], 'no save failed');
  assert.equal((await readDaemonState(process.cwd(), config)).mergeWriter.inFlights?.length, count, 'the saved state carries every head in flight');

  for (let round = 0; round < 6 && snapshot().some(item => item.stage !== 'done'); round++) {
    for (const release of held.splice(0)) release();
    await mergeWriterIdle(state);
    await cycle();
  }
  await Promise.all(saves);
  assert.deepEqual(failures.map(String), [], 'no save failed');
  assert.ok(snapshot().every(item => item.stage === 'done'), 'every head merged');
});
