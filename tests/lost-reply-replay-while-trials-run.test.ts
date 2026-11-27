import './helpers/temp-dirs.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { workFixture } from './helpers/work-fixture.js';
import { listen } from './helpers/http-server.js';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { mergeRecordKey, mergeWriterIdle, mergeWriterReads, mergeWriterSummary, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergePorts, MergeRecordEvent, MergeTrialRun } from '../src/merge-writer/executor.js';
import type { MergeLedgerState } from '../src/model/merge-ledger.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { Principal, Work } from '../src/model.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { completionBody } from '../src/cli/complete.js';
import { defaultChildRun } from '../src/child-runner.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const start = Date.parse('2030-07-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const baseTipSeed = sha('base-tip');
const config = masterConfigSchema.parse({
  version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
  workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy', parallel: 4 } },
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeWork(n: number, options: { ledger?: MergeLedgerState | null; files?: string[]; stage?: Work['stage'] } = {}): Work {
  const head = sha(`head-${n}`);
  const candidate = { sha: head, baseSha: baseTipSeed, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
  const ledger = options.ledger ?? null;
  const delivered = ledger?.state === 'reconciled';
  return workFixture({
    id: `w${n}`, key: `GY-${n}`, priority: 1,
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }],
    createdAt: iso(start + n * 1000), updatedAt: iso(start), stageEnteredAt: iso(start + n * 1000),
    epoch: 1, submission: { epoch: 1, pr: n }, candidate, mergeLedger: ledger,
    observation: {
      source: 'control-plane', candidate, files: options.files ?? [`src/file-${n}.ts`],
      checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null,
      mergeable: true, protected: false, baseTip: baseTipSeed, baseTipContained: true, at: iso(start),
    },
    gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: name !== 'test' && name !== 'merge', reasons: [] })),
    ...(delivered ? { stage: 'done' as const, delivery: { mergedAt: ledger!.pushedAt ?? iso(start), mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: options.stage ?? 'build' }),
  } as never);
}

test('unit:lost-reply-is-replayed-while-trials-run — lost progress reply with two other trials running is confirmed on the next step while B merges and C starts; already-recorded replay records nothing twice; a failing write holds only its own item and shows in status in one line', async () => {
  // Part 1: A's progress reply is lost while two other trials (D, E) are running; on the next step
  // A's write is replayed and confirmed (recognised by attempt id + write number, recording nothing twice)
  // AND B's passed trial merges in that very same step.
  let mainTip = baseTipSeed;
  const pushed = new Set<string>();
  const receipts = new Map<string, string>();
  const storedEvents = new Map<string, MergeRecordEvent[]>();
  const ledgers = new Map<string, MergeLedgerState>();
  const sent: { key: string; workKey: string; kind: string; answer: 'stored' | 'receipt' | 'lost' }[] = [];

  // B (GY-2) already has a passed trial on baseTipSeed ready for pushPassedTrial.
  const bHead = sha('head-2');
  const bMerge = sha(`merge:${bHead}:${baseTipSeed}`);
  ledgers.set('GY-2', {
    key: 'GY-2', state: 'intent', head: bHead, baseTip: baseTipSeed, mergeSha: bMerge, risk: 'normal',
    intentAt: iso(start), pushedAt: null, observedTip: null, refusal: null, events: 2,
    trial: { head: bHead, mergeSha: bMerge, passedBaseTip: baseTipSeed, proofs: { 'unit:item-works': { executed: 1, failed: 0 } } },
  });

  // Gates to control when A (GY-1), D (GY-4), E (GY-5) trials finish.
  const gates = { 'GY-1': deferred(), 'GY-4': deferred(), 'GY-5': deferred() };
  const startedTrials = new Set<string>();
  let lostOnce = false;
  let now = start;

  const record: MergePorts['record'] = async (item, event) => {
    const rKey = mergeRecordKey(item, event);
    const input = JSON.stringify(event);
    const held = receipts.get(rKey);
    if (held !== undefined) {
      assert.equal(held, input, 'replayed key carries identical input');
      sent.push({ key: rKey, workKey: item.key, kind: event.kind, answer: 'receipt' });
      return { receipt: rKey };
    }
    receipts.set(rKey, input);
    const list = storedEvents.get(item.key) ?? [];
    list.push(event);
    storedEvents.set(item.key, list);
    const prev = ledgers.get(item.key) ?? null;
    if (event.kind === 'intent') ledgers.set(item.key, { key: item.key, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (prev?.events ?? 0) + 1 });
    else if (event.kind === 'pushed' && prev) ledgers.set(item.key, { ...prev, state: 'pushed', pushedAt: event.pushedAt, events: prev.events + 1 });
    else if (event.kind === 'reconciled' && prev) ledgers.set(item.key, { ...prev, state: 'reconciled', observedTip: event.observedTip, events: prev.events + 1 });

    if (item.key === 'GY-1' && event.kind === 'trial-step' && !lostOnce) {
      lostOnce = true;
      sent.push({ key: rKey, workKey: item.key, kind: event.kind, answer: 'lost' });
      throw new Error('socket hang up');
    }
    sent.push({ key: rKey, workKey: item.key, kind: event.kind, answer: 'stored' });
    return { stored: rKey };
  };

  let includeB = false;
  const works = () => [
    fakeWork(1, { ledger: ledgers.get('GY-1') ?? null, files: ['src/shared.ts'] }),
    ...(includeB ? [fakeWork(2, { ledger: ledgers.get('GY-2') ?? null, files: ['src/b.ts'] })] : []),
    fakeWork(4, { ledger: ledgers.get('GY-4') ?? null, files: ['src/shared.ts'] }),
    fakeWork(5, { ledger: ledgers.get('GY-5') ?? null, files: ['src/shared.ts'] }),
  ];

  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => now, parallel: 4, cores: 8,
    fetch: async () => mainTip,
    merge: async (head, tip) => ({ mergeSha: sha(`merge:${head}:${tip}`), files: ['src/shared.ts'] }),
    trial: async (_mergeSha, _files, item, _baseTip, onStep) => {
      startedTrials.add(item.key);
      if (item.key === 'GY-1') onStep?.('tests');
      await gates[item.key as keyof typeof gates].promise;
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 100, logTail: 'ok', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
    },
    push: async (mergeSha, baseTip) => {
      if (baseTip !== mainTip) return 'rejected';
      mainTip = mergeSha;
      pushed.add(mergeSha);
      return 'pushed';
    },
    holds: async commit => pushed.has(commit),
    record,
  };

  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: works(), now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, rework: async () => {},
    mergeWriter: reads,
  } as unknown as DaemonEffects;

  const state = emptyDaemonState(config);
  // Cycle 1: A (GY-1), D (GY-4), E (GY-5) start trials concurrently (shared file prevents batching).
  await runCycle(config, state, effects, () => now);
  // Wait until all 3 trials have entered and A's progress reply has been lost.
  for (let i = 0; i < 100 && (!lostOnce || !state.mergeWriter.unconfirmed?.length || startedTrials.size < 3); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(startedTrials.size, 3, 'A, D, and E are all running trials');
  assert.equal(state.mergeWriter.unconfirmed?.length, 1, 'A has one unconfirmed progress write');
  assert.equal(state.mergeWriter.unconfirmed![0]!.key, 'GY-1');

  // Cycle 2: While D and E (and A) are STILL running, B (GY-2) is ready with a passed trial.
  // The next merge step replays A's lost progress write, recognises it by attempt+write without recording twice,
  // AND pushes/merges B in that same step!
  includeB = true;
  now += 20_000;
  await runCycle(config, state, effects, () => now);

  assert.equal(state.mergeWriter.unconfirmed, undefined, 'A unconfirmed progress write is confirmed on the next step even while trials run');
  const aStepSends = sent.filter(entry => entry.workKey === 'GY-1' && entry.kind === 'trial-step');
  assert.deepEqual(aStepSends.map(entry => entry.answer), ['lost', 'receipt'], 'replay hit the stored receipt');
  assert.equal(aStepSends[0]!.key, aStepSends[1]!.key, 'replay used the same attempt id and write number key');
  assert.equal((storedEvents.get('GY-1') ?? []).filter(e => e.kind === 'trial-step').length, 1, 'already-recorded write is not recorded twice');
  assert.equal(ledgers.get('GY-2')?.state, 'reconciled', 'B merges in that very same step');

  // Release all running trials cleanly.
  gates['GY-1'].resolve();
  gates['GY-4'].resolve();
  gates['GY-5'].resolve();
  await mergeWriterIdle(state);

  // Part 2: A write that keeps failing holds ONLY its own item (A):
  // - B's passed trial is still pushed
  // - C's waiting trial still starts
  // - A's own next write waits for its replay
  // - status shows A with item key, how long, and last error in one line.
  const state2 = emptyDaemonState(config);
  let now2 = start;
  let tip2 = baseTipSeed;
  const pushed2 = new Set<string>();
  const ledgers2 = new Map<string, MergeLedgerState>();
  const b2Head = sha('head-12'), b2Merge = sha(`merge:${b2Head}:${baseTipSeed}`);
  ledgers2.set('GY-12', {
    key: 'GY-12', state: 'intent', head: b2Head, baseTip: baseTipSeed, mergeSha: b2Merge, risk: 'normal',
    intentAt: iso(start), pushedAt: null, observedTip: null, refusal: null, events: 2,
    trial: { head: b2Head, mergeSha: b2Merge, passedBaseTip: baseTipSeed, proofs: { 'unit:item-works': { executed: 1, failed: 0 } } },
  });

  const aGate = deferred(), cGate = deferred();
  let cStarted = false;
  let aWriteFailing = true;
  const aRecordOrder: string[] = [];

  const record2: MergePorts['record'] = async (item, event) => {
    if (item.key === 'GY-11') {
      if (event.kind === 'trial-step' && aWriteFailing) {
        throw new Error('503 service unavailable\nupstream timeout');
      }
      aRecordOrder.push(`${item.mergeAttempt?.write}:${event.kind}`);
    }
    const prev = ledgers2.get(item.key) ?? null;
    if (event.kind === 'intent') ledgers2.set(item.key, { key: item.key, state: 'intent', head: event.head, baseTip: event.baseTip, mergeSha: event.mergeSha, risk: event.risk, intentAt: event.at, pushedAt: null, observedTip: null, refusal: null, events: (prev?.events ?? 0) + 1 });
    else if (event.kind === 'pushed' && prev) ledgers2.set(item.key, { ...prev, state: 'pushed', pushedAt: event.pushedAt, events: prev.events + 1 });
    else if (event.kind === 'reconciled' && prev) ledgers2.set(item.key, { ...prev, state: 'reconciled', observedTip: event.observedTip, events: prev.events + 1 });
    return { stored: mergeRecordKey(item, event) };
  };

  let includeBC = false;
  const works2 = () => [
    fakeWork(11, { ledger: ledgers2.get('GY-11') ?? null, files: ['src/a.ts'] }),
    ...(includeBC ? [
      fakeWork(12, { ledger: ledgers2.get('GY-12') ?? null, files: ['src/b.ts'] }),
      fakeWork(13, { ledger: ledgers2.get('GY-13') ?? null, files: ['src/c.ts'] }),
    ] : []),
  ];

  const reads2: MergeWriterReads = {
    baseBranch: 'main', now: () => now2, parallel: 4, cores: 8,
    fetch: async () => tip2,
    merge: async (head, tip) => ({ mergeSha: sha(`merge:${head}:${tip}`), files: ['src/x.ts'] }),
    trial: async (_mergeSha, _files, item, _baseTip, onStep) => {
      if (item.key === 'GY-11') { onStep?.('tests'); await aGate.promise; }
      else if (item.key === 'GY-13') { cStarted = true; await cGate.promise; }
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 100, logTail: 'ok', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
    },
    push: async (mergeSha, baseTip) => {
      if (baseTip !== tip2) return 'rejected';
      tip2 = mergeSha;
      pushed2.add(mergeSha);
      return 'pushed';
    },
    holds: async commit => pushed2.has(commit),
    record: record2,
  };
  const effects2 = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: works2(), now: iso(now2) }),
    closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, rework: async () => {},
    mergeWriter: reads2,
  } as unknown as DaemonEffects;

  // Start A (GY-11), its trial-step fails and joins unconfirmed.
  await runCycle(config, state2, effects2, () => now2);
  for (let i = 0; i < 100 && !state2.mergeWriter.unconfirmed?.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state2.mergeWriter.unconfirmed?.length, 1);

  // Release A's trial so A wants to send its `trial` write right now; it MUST wait for its unconfirmed `trial-step` replay!
  aGate.resolve();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(!aRecordOrder.some(entry => entry.endsWith(':trial')), `A's own next write must wait for its unconfirmed replay: ${JSON.stringify(aRecordOrder)}`);

  // Advance clock by 3 minutes, add B (passed trial) and C (waiting trial), and run another cycle while A's replay STILL fails.
  includeBC = true;
  now2 += 3 * 60_000;
  await runCycle(config, state2, effects2, () => now2);

  assert.equal(ledgers2.get('GY-12')?.state, 'reconciled', 'B still pushes while A write keeps failing');
  // Next cycle (since B delivered in previous cycle, delivered=true suppresses new trial starts on the landing cycle):
  // C starts while A's write is STILL failing!
  now2 += 60_000;
  await runCycle(config, state2, effects2, () => now2);
  for (let i = 0; i < 100 && !cStarted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cStarted, true, 'C still starts while A write keeps failing');
  assert.ok(!aRecordOrder.some(entry => entry.endsWith(':trial')), 'A next write still waits while its replay keeps failing');

  // Check status: shows item key, how long, and last error in one line.
  const summary = mergeWriterSummary(state2.mergeWriter, now2);
  assert.equal(summary.unconfirmed?.length, 1);
  const line = summary.unconfirmed![0]!;
  assert.ok(!line.includes('\n'), `status line must be one line: ${JSON.stringify(line)}`);
  assert.match(line, /GY-11/, 'status line names the item key');
  assert.match(line, /4m/, 'status line names how long');
  assert.match(line, /503 service unavailable upstream timeout/, 'status line names the last error');

  // Also check masterStatusReport attention carries it cleanly.
  const statusRoot = (await gitRepo({ label: 'unconfirmed-status' })).root;
  const credRoot = await temporaryDirectory('unconfirmed-cred');
  const statusConfig = masterConfigSchema.parse({ ...config, credentialFile: join(credRoot, 'coordinator.token') });
  await writeDaemonState(statusConfig, state2);
  const report = await masterStatusReport(statusRoot, statusConfig, async path => path === 'work-snapshot' ? { work: [], now: iso(now2) } : { messages: [] }, async () => '');
  const attentionRow = report.attention.find(row => row.subject === 'GY-11');
  assert.ok(attentionRow, `master status attention names GY-11: ${JSON.stringify(report.attention)}`);
  assert.ok(!attentionRow.text.includes('\n'), 'attention text is one line');
  assert.match(attentionRow.text, /GY-11.*4m.*503 service unavailable upstream timeout/);

  // Now allow A's replay to succeed on the next cycle; A's waiting `trial` write runs AFTER `trial-step` in write-number order!
  aWriteFailing = false;
  now2 += 20_000;
  await runCycle(config, state2, effects2, () => now2);
  cGate.resolve();
  await mergeWriterIdle(state2);
  assert.equal(state2.mergeWriter.unconfirmed, undefined, 'A unconfirmed write cleared');
  const stepIdx = aRecordOrder.findIndex(entry => entry.endsWith(':trial-step'));
  const trialIdx = aRecordOrder.findIndex(entry => entry.endsWith(':trial'));
  assert.ok(stepIdx >= 0 && trialIdx > stepIdx, `A writes applied in write-number order: ${JSON.stringify(aRecordOrder)}`);
});

// ---- AC-2: Integration test against a real database ------------------------------------------------

const repository = 'owner/project';
const admin: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const credentials = [admin, coordinator, worker].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let store: Store, engine: Engine, close: (() => Promise<void>) | undefined, url: string;
let fixtureRoot: string, origin: string, checkout: string, worktreeBase: string, realBaseTip: string;
const realHeads: Record<number, string> = {};

async function commitFile(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text);
  git(cwd, 'add', '--', path);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('lost-reply-integration'));
  origin = join(fixtureRoot, 'origin.git');
  checkout = join(fixtureRoot, 'checkout');
  worktreeBase = join(fixtureRoot, 'managed');
  git(fixtureRoot, 'init', '-q', '--bare', '-b', 'main', origin);
  git(fixtureRoot, 'clone', '-q', origin, checkout);
  git(checkout, 'config', 'user.email', 't@example.com');
  git(checkout, 'config', 'user.name', 'T');
  await commitFile(checkout, 'README.md', '# Fixture\n', 'base');
  await commitFile(checkout, 'src/app.ts', 'export const app = 1;\n', 'app');
  await commitFile(checkout, 'tests/app.test.ts', "import { test } from 'node:test';\ntest('unit:app-works — answers', () => {});\n", 'test');
  git(checkout, 'push', '-q', 'origin', 'main');
  realBaseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  for (const [n, file] of [[1, 'src/one.ts'], [2, 'src/two.ts']] as const) {
    const worktree = join(checkout, '.graphyard', 'worktrees', `GY-${n}-1`);
    git(checkout, 'worktree', 'add', '-q', '-b', `graphyard/gy-${n}-1`, worktree, realBaseTip);
    realHeads[n] = await commitFile(worktree, file, `export const value = ${n};\n`, `change ${n}`);
  }
  store = await withDatabase('lost-reply-integration');
  await store.init();
  engine = new Engine(store, 120, repository);
  engine.gitRunner = gitRunnerFor(checkout);
  engine.baseBranch = 'main';
  ({ url, close } = await listen(server(engine, credentials)));
});

after(async () => {
  await close?.();
  if (store) await store.close();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

async function apiRequest(credential: string, path: string, body?: unknown, key: string = randomUUID(), method = 'POST') {
  const response = await fetch(`${url}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}

async function submitRealItem(n: number) {
  let w = await engine.execute(admin, 'create', null, { type: 'chore', title: `Real fixture ${n}`, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:app-works', 'e2e:fixture'] }] }, randomUUID());
  w = await engine.execute(admin, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  w = pulled.assigned!;
  await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/lr-${n}`, branch: `graphyard/gy-${n}-1` }, randomUUID());
  const body = completionBody(['1', '--head', realHeads[n]!], () => realHeads[n]!);
  return engine.execute(worker, 'submit', w.id, body, randomUUID());
}

test('integration:dropped-record-reply-does-not-stall-other-items — dropping the reply to one record write during a two-trial run against a real database lets both items reach their verdicts with every ledger event recorded exactly once and in order', async () => {
  const w1 = await submitRealItem(1);
  const w2 = await submitRealItem(2);

  let droppedOnce = false;
  const trial1Gate = deferred();
  const trial2Gate = deferred();
  let trial2Started = false;

  const recordWithDrop: MergePorts['record'] = async (work, event) => {
    const answer = await apiRequest(token(coordinator), `work/${work.id}/merge-record`, event, mergeRecordKey(work, event));
    if (answer.status !== 200) throw Object.assign(new Error(`merge-record ${event.kind} refused (${answer.status}): ${JSON.stringify(answer.body)}`), { status: answer.status });
    // Drop the reply AFTER the server committed w1's trial-step write!
    if (work.id === w1.id && event.kind === 'trial-step' && !droppedOnce) {
      droppedOnce = true;
      throw new Error('socket hang up');
    }
    return answer.body;
  };

  const fixtureConfig = masterConfigSchema.parse({
    ...config,
    run: { mergeWriter: { deployKeyFile: join(fixtureRoot, 'deploy-key'), parallel: 2 } },
  });

  // Override push in reads to use local origin without SSH key, while keeping real git merge/fetch/holds and real HTTP record.
  const baseReads = mergeWriterReads(fixtureConfig, checkout, defaultChildRun, {
    base: worktreeBase,
    record: recordWithDrop,
    trial: async (given): Promise<MergeTrialRun> => {
      const proofFiles = [...given.proofFiles, ...(await given.discoverProofFiles?.({}) ?? [])];
      if (given.key === w1.key) {
        given.onStep?.('tests');
        await trial1Gate.promise;
      } else {
        trial2Started = true;
        await trial2Gate.promise;
      }
      return {
        build: 'pass',
        tests: { passed: proofFiles.length, failed: [], files: proofFiles.length },
        durationMs: 5,
        logTail: 'ok',
        files: proofFiles,
        proofs: Object.fromEntries([...given.proofs, ...(given.e2eProofs ?? [])].map(proof => [proof, { executed: 1, failed: 0 }])),
      };
    },
  });
  const reads: MergeWriterReads = {
    ...baseReads,
    push: async (mergeSha, baseTip) => {
      try {
        git(checkout, 'push', 'origin', `--force-with-lease=refs/heads/main:${baseTip}`, `${mergeSha}:refs/heads/main`);
        return 'pushed';
      } catch {
        return 'rejected';
      }
    },
  };

  let now = start;
  let includeW2 = false;
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: includeW2 ? [(await store.workDocument(w1.id))!, (await store.workDocument(w2.id))!] : [(await store.workDocument(w1.id))!], now: iso(now) }),
    closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, rework: async () => {},
    mergeWriter: reads,
  } as unknown as DaemonEffects;

  const state = emptyDaemonState(fixtureConfig);
  // Cycle 1: start w1's trial; its trial-step reply is dropped after the server commits it.
  await runCycle(fixtureConfig, state, effects, () => now);
  for (let i = 0; i < 100 && (!droppedOnce || !state.mergeWriter.unconfirmed?.length); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(droppedOnce, true, 'w1 trial-step reply was dropped');
  assert.equal(state.mergeWriter.unconfirmed?.length, 1, 'w1 unconfirmed write is queued for replay');

  // Release w1's trial so its next write (`trial`) waits for the replay of `trial-step`.
  trial1Gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 30));

  // Cycle 2: w2 joins and starts its trial in parallel while w1's dropped write is replayed in this same step!
  includeW2 = true;
  now += 20_000;
  await runCycle(fixtureConfig, state, effects, () => now);
  for (let i = 0; i < 100 && !trial2Started; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(trial2Started, true, 'w2 trial started concurrently without stalling on w1');
  assert.equal(state.mergeWriter.unconfirmed, undefined, 'dropped write replayed while trials are running');

  // Release w2's trial and let both flights settle.
  trial2Gate.resolve();
  await mergeWriterIdle(state);
  now += 20_000;
  await runCycle(fixtureConfig, state, effects, () => now);

  const doc1 = (await store.workDocument(w1.id))!;
  const doc2 = (await store.workDocument(w2.id))!;
  assert.equal(doc1.stage, 'done', 'item 1 reached its verdict and delivered');
  assert.equal(doc2.stage, 'done', 'item 2 reached its verdict and delivered');

  const eventsOf = async (id: string) => (await store.pool.query(
    "SELECT kind FROM events WHERE work_id=$1 AND kind LIKE 'merge.%' ORDER BY seq",
    [id],
  )).rows.map(row => row.kind as string);

  const e1 = await eventsOf(w1.id);
  const e2 = await eventsOf(w2.id);
  // Every ledger event for w1 is recorded exactly once and in order (trial-step before trial, then pushed, reconciled).
  assert.equal(e1.filter(k => k === 'merge.trial-step').length, 1, `w1 trial-step recorded exactly once: ${JSON.stringify(e1)}`);
  assert.equal(e1.filter(k => k === 'merge.trial').length, 1, `w1 trial recorded exactly once: ${JSON.stringify(e1)}`);
  assert.equal(e1.filter(k => k === 'merge.pushed').length, 1, `w1 pushed recorded exactly once: ${JSON.stringify(e1)}`);
  assert.equal(e1.filter(k => k === 'merge.reconciled').length, 1, `w1 reconciled recorded exactly once: ${JSON.stringify(e1)}`);
  assert.ok(e1.indexOf('merge.intent') < e1.indexOf('merge.trial-step'), `intent before trial-step: ${JSON.stringify(e1)}`);
  assert.ok(e1.indexOf('merge.trial-step') < e1.indexOf('merge.trial'), `trial-step before trial: ${JSON.stringify(e1)}`);
  assert.ok(e1.indexOf('merge.trial') < e1.indexOf('merge.pushed'), `trial before pushed: ${JSON.stringify(e1)}`);
  assert.ok(e1.indexOf('merge.pushed') < e1.indexOf('merge.reconciled'), `pushed before reconciled: ${JSON.stringify(e1)}`);

  // Every ledger event for w2 is recorded exactly once and in order.
  assert.equal(e2.filter(k => k === 'merge.trial').length, 1, `w2 trial recorded exactly once: ${JSON.stringify(e2)}`);
  assert.equal(e2.filter(k => k === 'merge.pushed').length, 1, `w2 pushed recorded exactly once: ${JSON.stringify(e2)}`);
  assert.equal(e2.filter(k => k === 'merge.reconciled').length, 1, `w2 reconciled recorded exactly once: ${JSON.stringify(e2)}`);
  assert.ok(e2.indexOf('merge.intent') < e2.indexOf('merge.trial'), `w2 intent before trial: ${JSON.stringify(e2)}`);
  assert.ok(e2.indexOf('merge.trial') < e2.indexOf('merge.pushed'), `w2 trial before pushed: ${JSON.stringify(e2)}`);
  assert.ok(e2.indexOf('merge.pushed') < e2.indexOf('merge.reconciled'), `w2 pushed before reconciled: ${JSON.stringify(e2)}`);
});
