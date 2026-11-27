import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { Launcher, runCycle, tickWaitMs, type Cycle } from '../src/daemon/cycle.js';
import { mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import type { TrialRunHandle, TrialRunRequest } from '../src/merge-writer/trial-run.js';
import { mergeRecordKinds, type MergeRecordEvent, type MergeTrialRun } from '../src/merge-writer/executor.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3965: a change moves to its next station in the same loop cycle. Each case records the
// loop's effects in order, with a marker where each cycle begins.
const proof = 'unit:loop-hand-offs-happen-in-the-same-cycle';
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-09-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const base = sha('base');
const pass: MergeTrialRun = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1000, logTail: '', files: ['tests/item.test.ts'], proofs: { 'unit:item-works': { executed: 1, failed: 0 } } };
const waitFor = async (what: () => boolean, ms = 5_000) => { for (let waited = 0; !what() && waited < ms; waited += 5) await new Promise(resolve => setTimeout(resolve, 5)); };

async function masterConfig(workers: number): Promise<MasterConfig> {
  const directory = await temporaryDirectory('loop-hand-offs');
  const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const credential = join(directory, 'worker.token'); await writeFile(credential, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile = (name: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} });
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: cli, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', workers: Array.from({ length: workers }, (_, index) => profile(`worker-${index + 1}`)) });
}

/** A ready item waiting for a builder. */
const ready = (key: string, priority: number): Work => workFixture({ key, title: `Item ${key}`, priority, createdAt: iso(clock - 3_600_000), updatedAt: iso(clock), stageEnteredAt: iso(clock - 3_600_000) });

/** One detached trial run, alive until it reaches its verdict. */
class Run {
  private verdict: MergeTrialRun | null = null;
  private watchers = new Set<(verdict: MergeTrialRun) => void>();
  constructor(readonly spec: TrialRunRequest, readonly directory: string) {}
  watch(): Promise<MergeTrialRun> { return this.verdict ? Promise.resolve(this.verdict) : new Promise(resolve => this.watchers.add(resolve)); }
  finish() { this.verdict = pass; for (const watcher of this.watchers) watcher(pass); this.watchers.clear(); }
  /** The loop watching it exits: the run lives on, unwatched. */
  die() { this.watchers.clear(); }
}

/** Main's chain, the merge ledger and the detached trial runs; heads 1..`submitted` are handed in. */
class World {
  main = [base];
  runs = new Map<string, Run>();
  ledgerEvents: { kind: string; payload: unknown; work: string }[] = [];
  merges = new Map<string, string>();
  /** Heads whose run a restarted loop cannot see yet. */
  hidden = new Set<string>();
  constructor(public submitted: number, readonly order: string[]) {}
  snapshot(): Work[] {
    const folded = foldMergeLedger(this.ledgerEvents as never);
    return Array.from({ length: this.submitted }, (_, index) => index + 1).map(n => {
      const ledger = folded[`GY-${n}`] ?? null, delivered = ledger?.state === 'reconciled';
      const candidate = { sha: sha(`head${n}`), baseSha: base, pr: n, branch: `graphyard/gy-${n}-1`, author: 'worker' };
      return workFixture({ id: `w${n}`, key: `GY-${n}`, title: `Item ${n}`, priority: 1, criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }], systemDriven: undefined,
        createdAt: iso(clock + n * 1000), updatedAt: iso(clock), stageEnteredAt: iso(clock + n * 1000), epoch: 1, submission: { epoch: 1, pr: n }, candidate, mergeLedger: ledger,
        observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [], merged: delivered, mergeSha: delivered ? ledger!.mergeSha : null, mergeable: true, protected: false, baseTip: this.main[0], baseTipContained: true, at: iso(clock) },
        gates: ['ready', 'build', 'review'].map(name => ({ name, passed: true, reasons: [] })),
        ...(delivered ? { stage: 'done', delivery: { mergedAt: ledger!.pushedAt!, mergeSha: ledger!.mergeSha!, authorizationRevision: 1 } } : { stage: 'build' }),
      } as never);
    });
  }
  reads(options: { parallel: number; adopt?: boolean; memory?: () => Promise<null> }): MergeWriterReads {
    const world = this;
    const handle = (run: Run): TrialRunHandle => ({ directory: run.directory, mergeSha: run.spec.mergeSha, trial: () => run.watch(), detach: () => {}, cancel: () => { world.runs.delete(run.spec.key); } });
    return {
      baseBranch: 'main', now: () => clock,
      fetch: async () => world.main[0]!,
      merge: async (head, tip) => { const mergeSha = sha(`merge:${head}:${tip}`); world.merges.set(mergeSha, head); return { mergeSha, files: ['src/item.ts'] }; },
      trial: async () => { throw new Error('these reads launch detached trial runs only'); },
      push: async mergeSha => {
        world.main.unshift(mergeSha);
        const head = world.merges.get(mergeSha), n = Array.from({ length: world.submitted }, (_, index) => index + 1).find(index => sha(`head${index}`) === head);
        world.order.push(`push:GY-${n}`);
        return 'pushed';
      },
      holds: async commit => world.main.includes(commit),
      record: async (item, event: MergeRecordEvent) => {
        const { kind, ...fields } = event as typeof event & { kind: string };
        const payload = kind === 'intent' ? { key: item.key, ...fields } : kind === 'refused' ? { ...fields, kind: 'merge' } : fields;
        world.ledgerEvents.push({ kind: mergeRecordKinds[kind], payload, work: item.key });
      },
      parallel: options.parallel, cores: 8, memory: options.memory ?? (async () => null),
      launchTrialRun: spec => {
        const run = new Run(spec, `/runs/${spec.key}`);
        world.runs.set(spec.key, run); world.order.push(`launch:${spec.key}`);
        return handle(run);
      },
      ...(options.adopt ? { adoptTrialRun: async (ref: { key: string; mergeSha: string; directory: string }) => {
        const run = world.runs.get(ref.key);
        if (!run || world.hidden.has(ref.key) || run.spec.mergeSha !== ref.mergeSha) return null;
        world.order.push(`adopt:${ref.key}`);
        return handle(run);
      } } : {}),
      stopTrialRun: ref => { for (const run of world.runs.values()) if (run.directory === ref.directory) world.runs.delete(run.spec.key); },
    } as MergeWriterReads;
  }
}

/** One loop process's merge step over the world; each call is one cycle, marked in the order. */
function mergeLoop(world: World, state: DaemonState, reads: MergeWriterReads) {
  let cycle = 0, at = clock;
  const effects = { mergeWriter: reads, persist: async () => {}, rework: async () => {} };
  return async () => {
    cycle += 1; at += 60_000; world.order.push(`cycle ${cycle}`);
    await mergeWriterStep({ state, effects, now: () => at, snapshot: { work: world.snapshot(), now: iso(at) }, performed: [] } as unknown as Cycle);
  };
}

test(`${proof} — the merge step starts without waiting for a dispatch tick already running, and no second tick starts while it runs`, async t => {
  const config = await masterConfig(1), state = emptyDaemonState(config), order: string[] = [];
  let ticks = 0, finishTick!: () => void;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {},
    snapshot: async () => { order.push('snapshot'); return { work: [], now: iso(clock) }; },
    dispatchTick: () => { ticks++; order.push('tick'); return new Promise<void>(resolve => { finishTick = resolve; }); },
    mergeWriter: { memory: async () => { order.push('merge step'); return null; } } as unknown as MergeWriterReads,
  };
  // Cycle 1 starts the tick, which outlasts the cycle's wait for it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = runCycle(config, state, effects, () => clock, undefined, () => {});
  for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(tickWaitMs);
  await first;
  t.mock.timers.reset();
  assert.deepEqual(order, ['snapshot', 'tick', 'merge step']);

  // Cycle 2 finds it still running: it starts no second tick and goes straight to the merge step.
  order.length = 0;
  const started = Date.now();
  await runCycle(config, state, effects, () => clock, undefined, () => {});
  assert.deepEqual(order, ['snapshot', 'merge step'], 'the merge step does not wait on the running tick');
  assert.ok(Date.now() - started < tickWaitMs / 2, 'the cycle ends without the tick wait');
  assert.equal(ticks, 1, 'no second tick starts while one runs');

  // Once it ends, the next cycle starts the next tick.
  finishTick();
  await new Promise(resolve => setImmediate(resolve));
  order.length = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const third = runCycle(config, state, effects, () => clock, undefined, () => {});
  for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(tickWaitMs);
  await third;
  assert.deepEqual(order, ['snapshot', 'tick', 'merge step']);
  assert.equal(ticks, 2);
});

test(`${proof} — a rework decided this cycle is applied before launches are chosen, so the reworked item takes the free builder in the same cycle`, async () => {
  const config = await masterConfig(1), state = emptyDaemonState(config), order: string[] = [];
  const candidate = { sha: sha('reworked'), baseSha: base, pr: 7, branch: 'graphyard/gy-7-1', author: 'worker-1-principal' };
  const review = { reviewer: 'reviewer', state: 'CHANGES_REQUESTED', sha: candidate.sha, body: 'BLOCKING: the assertion was weakened', submittedAt: iso(clock - 60_000) };
  const item = workFixture({ key: 'GY-7', title: 'Reworked', priority: 1, createdAt: iso(clock - 3_600_000), updatedAt: iso(clock), stageEnteredAt: iso(clock - 3_600_000), epoch: 1,
    submission: { epoch: 1, pr: 7 }, candidate, observation: { source: 'control-plane', candidate, files: ['src/app.ts'], checks: [], reviews: [review], merged: false, mergeSha: null, mergeable: true, protected: false, baseTip: base, baseTipContained: true, at: iso(clock) } } as never);
  let brief: string | undefined;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async list => Object.fromEntries(list.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [structuredClone(item)], now: iso(clock) }), closeSession: () => {}, persist: async () => {},
    rework: async work => { order.push(`rework:${work.key}`); },
    dispatch: async work => { order.push(`worker:${work.key}`); brief = work.lastRework?.reason; },
  };
  const launcher = new Launcher();
  await runCycle(config, state, effects, () => clock, launcher, () => {});
  await launcher.idle();
  assert.deepEqual(order, ['rework:GY-7', 'worker:GY-7'], 'the reworked item is launched in the cycle that reworked it');
  assert.match(brief ?? '', /requested changes .*the assertion was weakened/, 'the launch carries the rework reason');
});

test(`${proof} — a worker launch does not wait for the reviews-and-trials step, and launches keep priority order`, async () => {
  const config = await masterConfig(2), state = emptyDaemonState(config), order: string[] = [];
  const items = [ready('GY-11', 1), ready('GY-10', 0)];
  let dispatched = 0;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async list => Object.fromEntries(list.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: items, now: iso(clock) }), closeSession: () => {}, persist: async () => {},
    dispatch: async work => {
      order.push(`worker:${work.key}`);
      await new Promise(resolve => setTimeout(resolve, 20));
      dispatched++;
    },
    // The merge step holds until both workers are launched (or a second has passed).
    mergeWriter: { memory: async () => { order.push('merge step'); await waitFor(() => dispatched === 2, 1000); order.push('merge step ends'); return null; } } as unknown as MergeWriterReads,
  };
  const launcher = new Launcher();
  await runCycle(config, state, effects, () => clock, launcher, () => {});
  await launcher.idle();
  assert.deepEqual(order.filter(entry => entry !== 'merge step'), ['worker:GY-10', 'worker:GY-11', 'merge step ends'], 'both workers launch before the merge step ends, the priority-0 item first');
});

test(`${proof} — a cycle in which a merge landed starts the waiting trial when its slot is free`, { timeout: 30_000 }, async () => {
  const order: string[] = [], world = new World(1, order), state = emptyDaemonState(await masterConfig(0));
  const cycle = mergeLoop(world, state, world.reads({ parallel: 1 }));
  await cycle();
  await waitFor(() => world.runs.has('GY-1'));
  // GY-2 is handed in while GY-1's trial holds the one slot.
  world.submitted = 2;
  await cycle();
  world.runs.get('GY-1')!.finish();
  await mergeWriterIdle(state);
  await cycle();
  await waitFor(() => world.runs.has('GY-2'));
  assert.deepEqual(order, ['cycle 1', 'launch:GY-1', 'cycle 2', 'push:GY-1', 'cycle 3', 'launch:GY-2'], 'the cycle that records GY-1 landed starts GY-2\'s trial');
  assert.ok(state.actions[`merge-writer:GY-1:${sha('head1')}`]?.detail.startsWith('Merged GY-1'), JSON.stringify(state.actions));
});

test(`${proof} — a cycle in which a merge landed adopts a restarted trial, which runs once`, { timeout: 30_000 }, async () => {
  const order: string[] = [], world = new World(1, order), config = await masterConfig(0);
  // The first loop starts GY-1's trial, then GY-2's beside it.
  const before = emptyDaemonState(config), first = mergeLoop(world, before, world.reads({ parallel: 2 }));
  await first();
  await waitFor(() => world.runs.has('GY-1'));
  world.submitted = 2;
  await first();
  await waitFor(() => world.runs.has('GY-2'));
  // The loop restarts onto a new release; its first cycle can watch GY-1's run only.
  for (const run of world.runs.values()) run.die();
  const state = JSON.parse(JSON.stringify(before)) as DaemonState;
  world.hidden.add('GY-2');
  order.length = 0;
  const cycle = mergeLoop(world, state, world.reads({ parallel: 1, adopt: true }));
  await cycle();
  world.runs.get('GY-1')!.finish();
  await mergeWriterIdle(state);
  world.hidden.delete('GY-2');
  await cycle();
  assert.deepEqual(order, ['cycle 1', 'adopt:GY-1', 'push:GY-1', 'cycle 2', 'adopt:GY-2'], 'the cycle that records GY-1 landed adopts GY-2\'s trial');
  world.runs.get('GY-2')!.finish();
  await mergeWriterIdle(state);
  assert.ok(!order.includes('launch:GY-2'), 'the adopted trial is never launched again');
  assert.equal(world.main.length, 3, 'both heads landed');
});
