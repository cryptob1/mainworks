import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapGate, diagnosticsIntervalMs, runDiagnostics } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { Work } from '../src/model.js';

// GY-3973: a daily diagnostic failure that recurs after its item was done files a new item; while
// that item is open it is reused and nothing is filed twice.

const key = 'diagnostic:e2e:catalog';
const hour = 3_600_000;

/**
 * One install as the gate's diagnostics see it. Filings are idempotent on their key as the store is:
 * the same input again replays its item, and different input is refused. A cycle's work is what it
 * holds: open items, and an item delivered within the last day — a closed one is not listed.
 */
function install() {
  const items: Work[] = [], receipts = new Map<string, { input: string; item: string }>(), filings: string[] = [], noted: string[] = [];
  let clock = Date.parse('2026-11-26T04:00:00Z'), tips = 0;
  const reads = {
    baseBranch: 'main', now: () => clock, git: async () => '',
    createWork: async (input: unknown, idempotencyKey: string) => {
      const fingerprint = JSON.stringify(input), receipt = receipts.get(idempotencyKey);
      if (receipt) {
        if (receipt.input !== fingerprint) throw new Error('Idempotency key reused with different input');
        return { key: receipt.item };
      }
      const name = `GY-${10 * (receipts.size + 1)}`, at = new Date(clock).toISOString();
      receipts.set(idempotencyKey, { input: fingerprint, item: name });
      filings.push(idempotencyKey);
      items.push({ id: `id-${name}`, key: name, faultKey: key, stage: 'backlog', stageEnteredAt: at, updatedAt: at } as unknown as Work);
      return { key: name };
    },
    note: async (item: { key: string }) => { noted.push(item.key); },
  } as unknown as MergeWriterReads & { git: NonNullable<MergeWriterReads['git']> };
  const record = bootstrapGate('owner/project', 'b'.repeat(40));
  /** The ports a cycle builds over the work it holds. */
  const cycle = () => ({
    ...batchGatePorts(reads, items.filter(item => item.stage !== 'done' || clock - Date.parse(item.delivery?.mergedAt ?? '') < diagnosticsIntervalMs)),
    diagnose: async () => ({ failed: ['e2e:catalog'], catalogMs: 1 }),
  });
  const diagnose = async (ports: ReturnType<typeof cycle>) => { assert.deepEqual(await runDiagnostics(ports, record), ['e2e:catalog']); };
  return {
    items, filings, noted, record, cycle, diagnose,
    /** A day later. Unless `moved` is false, main moved: the next filing's text differs from the last. */
    nextDay: (moved = true) => { clock += diagnosticsIntervalMs; record.verified = String.fromCharCode(98 + (moved ? ++tips : tips)).repeat(40); },
    /** Delivers `item` an hour ago, inside the day GY-3693 lets a delivered item stand for its fault. */
    deliver: (item: Work) => Object.assign(item, { stage: 'done', delivery: { mergedAt: new Date(clock - hour).toISOString() } }),
  };
}

test('unit:diagnostic-refiles-after-close — a failure whose recorded item is done files and records a new item, each time it recurs (GY-3973)', async () => {
  const world = install();
  await world.diagnose(world.cycle());
  assert.deepEqual(world.filings, [key], 'the first failure files its item');
  assert.equal(world.record.filed![key]!.item, 'GY-10');

  // GY-10 was closed. The next day the case fails on the same commit: a filing under the first key would replay the closed item.
  world.items[0]!.stage = 'done';
  world.nextDay(false);
  await world.diagnose(world.cycle());
  assert.equal(world.filings.length, 2, 'a new item is filed');
  assert.equal(world.record.filed![key]!.item, 'GY-20', 'and recorded for the check');
  assert.deepEqual(world.noted, [], 'the closed item is not merely noted');

  // The next day GY-20 was delivered an hour ago, so a cycle still lists it, and the case fails on a
  // newer commit: its text differs, and the store refuses a key it already holds.
  world.nextDay();
  world.deliver(world.items[1]!);
  await world.diagnose(world.cycle());
  assert.equal(world.filings.length, 3, 'a new item is filed again');
  assert.equal(world.record.filed![key]!.item, 'GY-30', 'and recorded for the check');
  assert.deepEqual(world.noted, [], 'the delivered item is not merely noted');
  assert.equal(new Set(world.filings).size, 3, 'each filing has a key of its own');
});

test('unit:diagnostic-refiles-after-close — a failure whose recorded item is still open reuses it and files no duplicate (GY-3973)', async () => {
  const world = install();
  await world.diagnose(world.cycle());
  world.nextDay();
  await world.diagnose(world.cycle());
  assert.deepEqual(world.filings, [key], 'nothing is filed twice');
  assert.equal(world.record.filed![key]!.item, 'GY-10', 'and the open item stays the one recorded for the check');
});

test('unit:diagnostic-refiles-after-close — a run that meets the failure again before a cycle lists its new item files nothing twice (GY-3973)', async () => {
  const world = install(), cycle = world.cycle();
  await world.diagnose(cycle);
  world.record.diagnosticsAt = null; // due again at once, as a gate run that timed out starts again
  await world.diagnose(cycle);
  assert.deepEqual(world.filings, [key], 'the item the run filed itself is open to it: nothing is filed twice');
  assert.equal(world.record.filed![key]!.item, 'GY-10', 'and stays the one recorded for the check');
});
