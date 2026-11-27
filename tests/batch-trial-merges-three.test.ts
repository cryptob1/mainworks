import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeBatches, mergeHeads, mergeRecordKinds, type MergeRecordEvent, type MergeTrialInput } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { defaultChildRun } from '../src/child-runner.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';

// The scenario names its own host: its trials take no slot of the host's shared heavy-job budget (GY-3616).
delete process.env[slotsDirectoryVariable];

// GY-3625: compatible queued heads are validated in one merge trial on their combined tip, against a real
// bare origin; a failing batch is split in half down to the head whose own trial fails.

async function fixture(label: string, count: number, failing: (tree: string[]) => boolean) {
  const directory = await temporaryDirectory(label);
  const { root: checkout, origin, head: baseTip } = await gitRepo({ root: join(directory, 'checkout'), files: { 'shared.txt': 'base\n' }, origin: true }), work: Work[] = [];
  for (let n = 1; n <= count; n++) {
    git(checkout, 'checkout', '-q', '-b', `graphyard/gy-${n}-1`, baseTip);
    const file = `item-${n}.txt`;
    await writeFile(join(checkout, file), `item ${n}\n`);
    git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', `GY-${n} change`);
    const candidate = { sha: git(checkout, 'rev-parse', 'HEAD'), baseSha: baseTip, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
    work.push({ id: `w${n}`, key: `GY-${n}`, title: `Item ${n}`, type: 'feature', criteria: [{ id: 'AC-1', text: 'Works', proofs: [`unit:item-${n}-works`] }], submission: { epoch: 1, pr: n }, candidate,
      observation: { source: 'control-plane', candidate, files: [file], checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false, at: new Date().toISOString() },
      gates: [], policy: { checks: ['test'], review: true }, epoch: 1, policyRevision: 1, mergeLedger: null } as unknown as Work);
  }
  // Main moves past the heads' base, so each head lands as a merge commit of its own.
  git(checkout, 'checkout', '-q', '--detach', baseTip);
  await writeFile(join(checkout, 'shared.txt'), 'base, moved\n');
  git(checkout, 'commit', '-qam', 'main moves'); git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  const movedTip = git(checkout, 'rev-parse', 'HEAD');
  const events: { kind: string; payload: unknown; work: string }[] = [], trials: MergeTrialInput[] = [];
  const config = masterConfigSchema.parse({ version: 1, repository: 'owner/project', baseBranch: 'main', url: 'https://graphyard.example', credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key') } } });
  const reads = mergeWriterReads(config, checkout, defaultChildRun, { base: join(directory, 'managed'),
    trial: async input => {
      trials.push(input);
      const tree = git(checkout, 'ls-tree', '--name-only', input.mergeSha).split('\n');
      const proofs = Object.fromEntries(input.proofs.map(proof => [proof, { executed: 1, failed: 0 }]));
      return failing(tree)
        ? { build: 'pass', tests: { passed: 0, failed: ['tests/item.test.ts'], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs }
        : { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: ['tests/item.test.ts'], proofs };
    },
    record: async (item, event: MergeRecordEvent) => {
      const { kind, ...payload } = event;
      events.push({ kind: mergeRecordKinds[kind], work: item.key, payload: kind === 'intent' ? { ...payload, key: item.key } : kind === 'refused' ? { ...payload, kind: 'merge' } : payload });
    } });
  return { origin, baseTip: movedTip, work, reads, events, trials };
}

/** Main's first-parent history above `baseTip`, oldest first: each landing's subject and second parent. */
const landings = (origin: string, baseTip: string) => git(origin, 'log', '--first-parent', '--reverse', '--format=%P|%s', `${baseTip}..main`).split('\n').filter(Boolean)
  .map(line => { const [parents, subject] = line.split('|') as [string, string]; return { subject, second: parents.split(' ')[1] }; });

test('integration:batch-trial-merges-three — three normal heads with disjoint files: one trial on the combined tip over the union of their tests, three merges in queue order, each with its own trial record naming the batch', { timeout: 60_000 }, async () => {
  const f = await fixture('batch-trial-three', 3, () => false);
  const results = await mergeHeads(f.reads, f.work);
  assert.deepEqual(results.map(result => 'outcome' in result ? result.outcome.outcome : String(result.error)), ['merged', 'merged', 'merged']);
  assert.equal(f.trials.length, 1, 'one trial for the batch');
  assert.deepEqual([...f.trials[0]!.changedFiles].sort(), ['item-1.txt', 'item-2.txt', 'item-3.txt'], 'the trial selects tests from the union of the three changes');
  assert.deepEqual([...f.trials[0]!.proofs].sort(), ['unit:item-1-works', 'unit:item-2-works', 'unit:item-3-works']);
  assert.deepEqual(git(f.origin, 'ls-tree', '--name-only', f.trials[0]!.mergeSha).split('\n').sort(), ['item-1.txt', 'item-2.txt', 'item-3.txt', 'shared.txt'], 'the trial ran on the combined tip');
  const landed = landings(f.origin, f.baseTip);
  assert.deepEqual(landed.map(entry => entry.subject.split(':')[0]), ['Merge GY-1', 'Merge GY-2', 'Merge GY-3'], 'each head lands as its own merge commit, in queue order');
  assert.deepEqual(landed.map(entry => entry.second), f.work.map(item => item.candidate!.sha), 'each merge commit carries its reviewed head unchanged');
  const ledger = foldMergeLedger(f.events);
  for (const item of f.work) {
    const state = ledger[item.key]!;
    assert.equal(state.state, 'reconciled', item.key);
    assert.equal(state.trial?.head, item.candidate!.sha, `${item.key}'s trial result is its own`);
    assert.equal(state.trial?.mergeSha, state.mergeSha, `${item.key}'s trial is bound to the commit that merged it`);
    assert.deepEqual(state.trial?.proofs, { [`unit:${item.key.replace('GY-', 'item-')}-works`]: { executed: 1, failed: 0 } }, `${item.key}'s proof is attested on its merge commit`);
    const trial = f.events.find(event => event.kind === 'merge.trial' && event.work === item.key)!.payload as { batch?: string[] };
    assert.deepEqual(trial.batch, ['GY-1', 'GY-2', 'GY-3'], `${item.key}'s trial result names the batch`);
  }
});

test('integration:batch-trial-merges-three — a sensitive head, or one sharing a changed file, is trialled alone', () => {
  const head = (key: string, files: string[]) => ({ key, candidate: { sha: 'a'.repeat(40) }, observation: { candidate: { sha: 'a'.repeat(40) }, files, scopeFiles: null }, mergeLedger: null }) as unknown as Work;
  const a = head('GY-1', ['a.txt']), b = head('GY-2', ['b.txt']), sharing = head('GY-3', ['b.txt']), sensitive = head('GY-4', ['src/store/x.ts']), c = head('GY-5', ['c.txt']), d = head('GY-6', ['d.txt']), e = head('GY-7', ['e.txt']), g = head('GY-8', ['g.txt']), h = head('GY-9', ['h.txt']);
  const keys = (batches: Work[][]) => batches.map(batch => batch.map(item => item.key));
  assert.deepEqual(keys(mergeBatches([a, b, sharing, sensitive, c])), [['GY-1', 'GY-2'], ['GY-3'], ['GY-4'], ['GY-5']]);
  assert.deepEqual(keys(mergeBatches([a, b, c, d, e, g, h])), [['GY-1', 'GY-2', 'GY-5', 'GY-6'], ['GY-7', 'GY-8', 'GY-9']], 'a batch never exceeds 4 heads');
});

test('integration:batch-trial-merges-three — one failing head among four: the batch is split, three merge, the one whose own trial fails is sent back with its reason, at most 4 trials', { timeout: 60_000 }, async () => {
  const f = await fixture('batch-trial-split', 4, tree => tree.includes('item-4.txt'));
  const results = await mergeHeads(f.reads, f.work);
  assert.deepEqual(results.map(result => 'outcome' in result ? result.outcome.outcome : String(result.error)), ['merged', 'merged', 'merged', 'refused']);
  assert.ok(f.trials.length <= 4, `${f.trials.length} trials ran`);
  assert.deepEqual(landings(f.origin, f.baseTip).map(entry => entry.subject.split(':')[0]), ['Merge GY-1', 'Merge GY-2', 'Merge GY-3']);
  const refused = results[3]!;
  assert.ok('outcome' in refused && refused.outcome.outcome === 'refused' && refused.outcome.reason === `${trialFailurePrefix}: tests tests/item.test.ts`, JSON.stringify(refused));
  const ledger = foldMergeLedger(f.events);
  assert.equal(ledger['GY-4']!.state, 'refused');
  assert.equal(ledger['GY-4']!.refusal?.reason, `${trialFailurePrefix}: tests tests/item.test.ts`, 'sent back with its own trial\'s reason');
  const own = f.events.filter(event => event.kind === 'merge.trial' && event.work === 'GY-4').map(event => event.payload as { mergeSha: string; batch?: string[] });
  assert.equal(own.length, 1); assert.equal(own[0]!.batch, undefined, 'its own trial, alone');
  for (const item of f.work.slice(0, 3)) {
    const state = ledger[item.key]!;
    assert.equal(state.state, 'reconciled', item.key);
    assert.equal(state.trial?.mergeSha, state.mergeSha, `${item.key}'s proof is attested on the commit that merged it`);
    assert.equal(state.trial?.passedBaseTip, state.baseTip);
  }
});
