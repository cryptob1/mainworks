import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, runGate } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import { mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { boundDaemonState, daemonStateSchema, type DaemonState } from '../src/daemon/state.js';
import { Engine } from '../src/engine.js';
import type { Principal, Work } from '../src/model.js';
import { mergeRecordKey, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { readFlow } from '../src/server/flow.js';
import { recordMergeEvent } from '../src/server/merge-record.js';
import type { Services } from '../src/server/routes.js';
import { Store } from '../src/store.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { mergeDelivered } from './helpers/merge-ledger.js';
import { itemObservation } from './helpers/observation-fixture.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { lifecycle } from './helpers/work-lifecycle.js';

// GY-4068: the flow numbers count a revert by its merge.serve-revert ledger row. The loop's
// serve-revert flight writes one (settleServeRevertFlight); the batch gate's revert port wrote
// none, so the 6-hour flow read showed reverts 0 with a gate revert inside it. A gate revert now
// records the same row on the reverted item, beside the re-land it files.

// Every fixture item carries an E2E proof and declares the serve its trial needs.
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const repository = 'owner/project', check = 'test:tests/a.test.ts';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;
const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'agent-a', role: 'worker', runtime: 'claude' };
const writer: Principal = { id: 'merge-writer', role: 'coordinator', sessionKind: 'ai' };

let store: Store, engine: Engine;
before(async () => {
  store = await withDatabase('gate-revert-counted-in-flow');
  await store.init();
  engine = new Engine(store, 120, repository);
  engine.principals = [operator, worker, writer];
});
after(async () => { await store?.close(); });

/** The ledger's record through the control plane's own merge-record handler, as the loop's coordinator writes it. */
const recordOnPlane = (item: Parameters<MergeWriterReads['record']>[0], event: MergeRecordEvent) => recordMergeEvent({ engine } as unknown as Services, writer, item.id, event, mergeRecordKey(item, event));

/** The merge.serve-revert row a gate revert of `mergeSha` from the gated `tip` writes, its instant aside. */
const row = (tip: string, mergeSha: string, revertSha: string) => ({ serve: tip, mergeSha, outcome: 'reverted', revertSha, reason: null, reland: 'GY-9000', failingCase: check, failingStep: null, failingReason: `the batch gate's check ${check} failed` });
const reverts = async (work: Work) => (await readFlow(store.pool, [(await store.workItem(work.id))!], Date.now()))['6h'].reverts;

/**
 * A main whose verified base is followed by one item's merge commit and a commit no item owns, so
 * the gated tip is not the landing itself. The item is delivered through the ledger by that merge,
 * and the control plane reads main from the coordinator checkout. The loop's ports push and fetch
 * there as the merge writer does with a token or the gh login: against the repository's explicit
 * URL, spelled unlike the named origin's, so a push leaves the checkout's `refs/remotes/origin/main`
 * where the last fetch put it.
 */
async function world(record: MergeWriterReads['record']) {
  const base = await temporaryDirectory('gate-revert-counted-in-flow'), coordinator = join(base, 'coordinator');
  const { root: pusher, origin, head: verified } = await gitRepo({ root: join(base, 'pusher'), origin: true, files: { 'graphyard.json': '{}' } });
  const created = await lifecycle(engine, operator, { type: 'chore', title: 'Gate revert counted in flow', criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:works', 'e2e:fixture'] }] }, { claim: worker, submit: {} });
  const scope = { source: 'control-plane' as const, files: ['src/a.ts'], scopeFiles: [{ path: 'src/a.ts', status: 'modified' as const, sha: null, additions: 1, deletions: 0, binary: false }] };
  const submitted = await engine.observe(created.id, created.revision, itemObservation(created, 'a'.repeat(40), 'b'.repeat(40), scope));
  git(pusher, 'checkout', '-q', '-b', 'change');
  await writeFile(join(pusher, 'a.ts'), 'broken\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', `${created.key}: change`);
  git(pusher, 'checkout', '-q', 'main');
  git(pusher, 'merge', '-q', '--no-ff', '-m', `Merge ${created.key}: change`, 'change');
  const mergeSha = git(pusher, 'rev-parse', 'HEAD');
  await writeFile(join(pusher, 'notes.txt'), 'unrelated\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'chore: unrelated'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);
  engine.gitRunner = gitRunnerFor(coordinator);
  await mergeDelivered(engine, submitted, mergeSha);
  const work = (await store.workItem(created.id))!;
  assert.equal(work.stage, 'done');
  assert.equal(work.delivery?.mergeSha, mergeSha, 'the item is delivered by the merge the gate will revert');
  const filed: string[] = [], url = `file://${origin}`;
  const reads = {
    baseBranch: 'main', now: Date.now, record,
    fetch: async () => { git(coordinator, 'fetch', '-q', '--no-tags', url, '+refs/heads/main:refs/remotes/origin/main'); return git(coordinator, 'rev-parse', 'refs/remotes/origin/main'); },
    git: async (args: string[], extra?: Record<string, string>) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extra } }),
    trial: async (_sha: string, _files: readonly string[], _item: unknown, _base?: string, onStep?: (step: string) => void) => { onStep?.('install'); return passing; },
    push: async (sha: string, baseTip: string) => {
      git(coordinator, 'push', '-q', `--force-with-lease=refs/heads/main:${baseTip}`, url, `${sha}:refs/heads/main`);
      assert.equal(git(coordinator, 'rev-parse', 'refs/remotes/origin/main'), baseTip, 'a push to the explicit URL leaves refs/remotes/origin/main where it was');
      return 'pushed' as const;
    },
    createWork: async (_input: unknown, key: string) => { filed.push(key); return { key: 'GY-9000' }; },
  } as unknown as MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> };
  return { origin, verified, mergeSha, tip, work, reads, filed };
}

/** The gate over a `world`: its checks answer by commit, the landing breaking `check`, which passes on the verified base. It answers the revert's commit. */
const gate = (yard: Awaited<ReturnType<typeof world>>, state?: DaemonState) => {
  const ports = { ...batchGatePorts(yard.reads, [yard.work], () => null, state), checkpoint: async () => {},
    run: async (commit: string, checks: readonly string[]) => checks.map(entry => entry === 'affected' ? check : entry).filter(entry => entry === check && commit !== yard.verified) };
  return async () => {
    const outcome = await runGate(ports, bootstrapGate(repository, yard.verified));
    assert.equal(outcome.outcome, 'reverted', JSON.stringify(outcome));
    const revertSha = outcome.outcome === 'reverted' ? outcome.revertSha : '';
    assert.equal(outcome.tip, yard.tip);
    assert.equal(git(yard.origin, 'rev-parse', 'main'), revertSha, 'the revert is pushed onto main');
    assert.equal(git(yard.origin, 'rev-parse', 'main^'), yard.tip, 'on the gated tip');
    assert.equal(git(yard.origin, 'log', '-1', '--format=%s', 'main'), `Revert "Merge ${yard.work.key}: change"`);
    assert.deepEqual(yard.filed, [`gate-reland:${yard.mergeSha}`], 'the re-land is filed once, under its key');
    return revertSha;
  };
};

test('integration:gate-revert-counted-in-flow — a batch gate revert writes the serve-revert record on the reverted item, so the flow counts it, and the re-land is still filed', { timeout: 60_000 }, async () => {
  // The control plane's own handler answers the record; a refusal is the test's to name.
  const refused: string[] = [];
  const yard = await world(async (item, event) => {
    try { return await recordOnPlane(item, event); }
    catch (error) { refused.push(error instanceof Error ? error.message : String(error)); throw error; }
  });
  assert.equal(await reverts(yard.work), 0, 'nothing is reverted yet');
  const revertSha = await gate(yard)();

  // The revert is one merge.serve-revert row on the reverted item, so the flow counts it once.
  assert.deepEqual(refused, [], 'the control plane accepted the record');
  assert.equal(await reverts(yard.work), 1, 'the flow revert count rises by one');
  const rows = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='merge.serve-revert'", [yard.work.id])).rows;
  assert.equal(rows.length, 1, 'one revert is one row');
  const { at, ...payload } = rows[0].payload;
  assert.deepEqual(payload, row(yard.tip, yard.mergeSha, revertSha));
  assert.ok(Number.isFinite(Date.parse(at)), `the row carries its instant: ${at}`);
  assert.deepEqual((await store.workItem(yard.work.id))!.mergeLedger?.serveReverts, [rows[0].payload], "the item's ledger holds the revert as a loop serve revert's");
});

test('integration:gate-revert-counted-in-flow — a record the control plane does not take is owed to the loop, whose next merge-writer step writes it, so the revert is still counted once', { timeout: 60_000 }, async () => {
  const state = daemonStateSchema.parse({ version: 1, url: 'https://graphyard.example', repository });
  // The control plane does not answer the gate's first record, as it would not while it restarts; every later one it takes.
  let unanswered = true;
  const yard = await world(async (item, event) => {
    if (unanswered) { unanswered = false; throw new Error('the control plane did not answer'); }
    return recordOnPlane(item, event);
  });
  assert.equal(await reverts(yard.work), 0, 'nothing is reverted yet');
  const revertSha = await gate(yard, state)();
  assert.equal(await reverts(yard.work), 0, 'the unrecorded revert is not counted yet');

  // The revert rides as a receipt the ledger has not acknowledged, as one an older loop left does.
  const [owed] = state.mergeWriter.serveRevert?.reverts ?? [];
  assert.ok(owed, 'the refused record is owed to the loop');
  const { at, ...receipt } = owed, { outcome: _outcome, reason: _reason, ...landed } = row(yard.tip, yard.mergeSha, revertSha);
  assert.deepEqual(receipt, { recorded: false, culprit: yard.work.key, ...landed });
  assert.ok(Number.isFinite(Date.parse(at)), `the receipt carries its instant: ${at}`);
  assert.deepEqual(boundDaemonState(state).mergeWriter.serveRevert?.reverts, [owed], "the loop's persisted state keeps the receipt until the ledger acknowledges it");

  // The loop's next merge-writer step writes it, and the flow counts the revert once.
  await mergeWriterStep({ state, effects: { mergeWriter: yard.reads, persist: async () => {} } as unknown as DaemonEffects, now: Date.now,
    snapshot: { work: [(await store.workItem(yard.work.id))!], now: new Date().toISOString() }, performed: [] } as unknown as Cycle);
  assert.equal(owed.recorded, true, 'the ledger acknowledged the receipt');
  assert.equal(await reverts(yard.work), 1, 'the flow revert count rises by one');
  const rows = (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='merge.serve-revert'", [yard.work.id])).rows;
  assert.equal(rows.length, 1, 'one revert is one row');
  const { at: writtenAt, ...written } = rows[0].payload;
  assert.deepEqual(written, row(yard.tip, yard.mergeSha, revertSha));
  assert.ok(Number.isFinite(Date.parse(writtenAt)), `the row carries its instant: ${writtenAt}`);
});
