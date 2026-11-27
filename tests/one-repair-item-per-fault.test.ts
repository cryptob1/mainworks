import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import {
  controlPlaneStep,
  controlPlaneUpgradeItem,
  stepStallItem,
  trialHostFaultItem,
  trialImageFaultItem,
  trialNetworkFaultItem,
  trialSandboxFaultItem,
} from '../src/daemon/control-plane.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import { gateFiledItem } from '../src/daemon/control-plane.js';
import { bootstrapGate, runGate } from '../src/batch-gate.js';
import { controlPlaneRecordPath, writeControlPlaneRecord } from '../src/deploy-watch.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MasterConfig } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import { mainworksRepository } from '../src/scenarios.js';

const sha = (n: number) => String(n).padStart(40, 'a');
const hour = 3_600_000;

interface RecordedItem {
  id: string;
  key: string;
  title: string;
  faultKey?: string;
  stage: Work['stage'];
  stageEnteredAt: string;
  updatedAt: string;
  delivery?: Work['delivery'];
  closure?: Work['closure'];
  agentRequests: { id: string; type: 'note'; reason: string; at: string; state: 'open' }[];
}

function fakeBoard(now: () => number) {
  const items: RecordedItem[] = [];
  const createWork = async (input: { title: string; faultKey?: string }, _key: string) => {
    const key = `GY-${items.length + 1}`;
    const at = new Date(now()).toISOString();
    items.push({
      id: `id-${items.length + 1}`,
      key,
      title: input.title,
      faultKey: input.faultKey,
      stage: 'backlog',
      stageEnteredAt: at,
      updatedAt: at,
      agentRequests: [],
    });
    return { key };
  };
  const note = async (item: Pick<Work, 'id' | 'key'>, text: string, _key: string) => {
    const target = items.find(entry => entry.id === item.id || entry.key === item.key);
    assert.ok(target, `note target ${item.key} must exist`);
    target.agentRequests.push({
      id: `note-${target.agentRequests.length + 1}`,
      type: 'note',
      reason: text,
      at: new Date(now()).toISOString(),
      state: 'open',
    });
  };
  const work = () => items as unknown as Work[];
  return { items, createWork, note, work };
}

test('unit:one-repair-item-per-fault — every loop-filed and release-check item carries a faultKey, and control-plane-upgrade keys by step', () => {
  const record = { commit: sha(1), verified: sha(2), failedStep: 'restart', failedReason: 'did not come back' };
  const items: Record<string, { faultKey?: string }> = {
    'control-plane-upgrade:restart': controlPlaneUpgradeItem(record as Parameters<typeof controlPlaneUpgradeItem>[0]) as { faultKey?: string },
    'loop-step-stall:dispatch': stepStallItem('dispatch', 'owner/game') as { faultKey?: string },
    'trial-host-fault:registry.npmjs.org': trialHostFaultItem('registry.npmjs.org', 'owner/game') as { faultKey?: string },
    'trial-image-fault:owner/game': trialImageFaultItem('owner/game') as { faultKey?: string },
    'trial-sandbox-fault:owner/game': trialSandboxFaultItem('owner/game') as { faultKey?: string },
    'trial-network-fault:owner/game': trialNetworkFaultItem('owner/game', '31') as { faultKey?: string },
    'flake:test:tests/a.test.ts': gateFiledItem({ key: 'flake:test:tests/a.test.ts', title: 'Flaky check on main: test:tests/a.test.ts', description: 'Flaked.' }, 'main', mainworksRepository) as { faultKey?: string },
    'known-red:test:tests/b.test.ts': gateFiledItem({ key: 'known-red:test:tests/b.test.ts', title: 'Known red on main: test:tests/b.test.ts', description: 'Red.' }, 'main', mainworksRepository) as { faultKey?: string },
    'diagnostic:e2e:board': gateFiledItem({ key: 'diagnostic:e2e:board', title: 'Diagnostic failure on main: e2e:board', description: 'Failed.' }, 'main', mainworksRepository) as { faultKey?: string },
  };
  for (const [expectedKey, item] of Object.entries(items)) {
    assert.equal(item.faultKey, expectedKey, `expected faultKey ${expectedKey}`);
  }
});

test('unit:one-repair-item-per-fault — filing the control-plane-upgrade fault five times across cycles creates one item and four notes', async () => {
  const root = await temporaryDirectory('one-repair-control-plane');
  let clock = Date.parse('2026-11-22T00:00:00Z');
  const board = fakeBoard(() => clock);
  const config = { url: 'http://127.0.0.1:5', repository: mainworksRepository, hostId: 'test-host' } as unknown as MasterConfig;
  const state = emptyDaemonState(config);

  for (let i = 0; i < 5; i++) {
    // Advance verified commit each cycle to mirror real main moving while restart stays stuck.
    await writeControlPlaneRecord(controlPlaneRecordPath(root), {
      commit: sha(1),
      verified: sha(10 + i),
      verifiedSeenAt: new Date(clock).toISOString(),
      failedStep: 'restart',
      failedReason: `restart failed on pass ${i + 1}`,
      failedAt: new Date(clock).toISOString(),
    });
    const cycle = {
      config,
      state,
      clock,
      log: () => {},
      snapshot: { work: board.work(), now: new Date(clock).toISOString() },
      effects: {
        mergeWriter: {
          gate: { root, repository: mainworksRepository },
          createWork: board.createWork,
          note: board.note,
        },
      },
    } as unknown as Parameters<typeof controlPlaneStep>[0];
    await controlPlaneStep(cycle);
    state.cycle += 1;
    clock += 60_000;
  }

  assert.equal(board.items.length, 1, 'five cycles file exactly one repair item');
  assert.equal(board.items[0]!.faultKey, 'control-plane-upgrade:restart');
  assert.equal(board.items[0]!.agentRequests.length, 4, 'the four repeat cycles each add a note');
});

test('unit:one-repair-item-per-fault — flaky-check fault files no second item while open or one hour after merge, and files a new item 25 hours after delivery', async () => {
  let clock = Date.parse('2026-11-22T00:00:00Z');
  const board = fakeBoard(() => clock);
  const check = 'test:tests/flaky.test.ts';
  const verified = sha(1);

  const fileOnce = async (tip: string) => {
    const record = bootstrapGate(mainworksRepository, verified);
    let runs = 0;
    const reads = {
      now: () => clock,
      baseBranch: 'main',
      fetch: async () => tip,
      git: async (args: string[]) => {
        if (args[0] === 'ls-tree') return '';
        if (args[0] === 'show') return JSON.stringify({ gate: { core: [] } });
        if (args[0] === 'diff') return 'tests/flaky.test.ts\n';
        if (args[0] === 'log') return '';
        return '';
      },
      trial: async () => {
        runs += 1;
        // First run fails the flaky test; rerun passes -> triggers flake filing.
        return {
          build: 'pass' as const,
          tests: { failed: runs === 1 ? ['tests/flaky.test.ts'] : [] },
          e2e: [],
        };
      },
      gate: { root: '/unused', repository: mainworksRepository },
      createWork: board.createWork,
      note: board.note,
    } as unknown as MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> };
    const ports = batchGatePorts(reads, board.work());
    ports.landings = async () => [];
    ports.files = async () => ['tests/flaky.test.ts'];
    ports.catalog = async () => [];
    ports.core = async () => [];
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'verified');
  };

  // 1. First flake: files GY-1.
  await fileOnce(sha(2));
  assert.equal(board.items.length, 1, 'initial flake files one item');
  assert.equal(board.items[0]!.faultKey, `flake:${check}`);

  // 2. While GY-1 is open, filing again via ports.file adds a note and creates no second item.
  const openReads = {
    now: () => clock,
    baseBranch: 'main',
    fetch: async () => sha(3),
    git: async () => '',
    gate: { root: '/unused', repository: mainworksRepository },
    createWork: board.createWork,
    note: board.note,
  } as unknown as MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> };
  await batchGatePorts(openReads, board.work()).file({
    key: `flake:${check}`,
    title: `Flaky check on main: ${check}`,
    description: 'Flaked again while open.',
  });
  assert.equal(board.items.length, 1, 'no second item while open');
  assert.equal(board.items[0]!.agentRequests.length, 1, 'note added to open item');

  // 3. Merge (deliver) GY-1, then advance 1 hour and trigger flake again -> still no second item, adds a note.
  const mergedAt = new Date(clock).toISOString();
  board.items[0]!.stage = 'done';
  board.items[0]!.stageEnteredAt = mergedAt;
  board.items[0]!.delivery = { mergedAt } as Work['delivery'];
  clock += 1 * hour;

  await fileOnce(sha(4));
  assert.equal(board.items.length, 1, 'no second item 1 hour after merge');
  assert.equal(board.items[0]!.agentRequests.length, 2, 'note added to recently delivered item');

  // 4. Advance to 25 hours after delivery -> a new item IS filed.
  clock += 24 * hour;
  await fileOnce(sha(5));
  assert.equal(board.items.length, 2, 'a new item is filed 25 hours after delivery');
  assert.equal(board.items[1]!.faultKey, `flake:${check}`);
  assert.equal(board.items[1]!.stage, 'backlog');

  // 5. Close GY-2 without delivery, then 1 hour later trigger flake again -> no third item, note added to GY-2.
  const closedAt = new Date(clock).toISOString();
  board.items[1]!.stage = 'done';
  board.items[1]!.stageEnteredAt = closedAt;
  board.items[1]!.closure = { kind: 'obsolete', reason: 'closed', ref: null, by: 'operator', at: closedAt, from: 'backlog' };
  clock += 1 * hour;
  await fileOnce(sha(6));
  assert.equal(board.items.length, 2, 'no new item 1 hour after close');
  assert.equal(board.items[1]!.agentRequests.length, 1, 'note added to recently closed item');
});
