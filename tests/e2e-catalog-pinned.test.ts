import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateCeilingMs } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';

// GY-3816: the whole catalog takes about 55 minutes, but the diagnostics bounded its trial by the
// 45-minute gate limit, so e2e-catalog timed out after 2700s on every daily run. Its trial is bounded
// by the gate ceiling, the same 90 minutes a gate run of the whole catalog may take.

test('unit:e2e-catalog-pinned — the diagnostics trial of the whole catalog is bounded by the gate ceiling, not the 45-minute limit (GY-3816)', async () => {
  const timeouts: Record<string, number | undefined> = {};
  const reads = {
    baseBranch: 'main', now: Date.now, fetch: async () => 'a'.repeat(40),
    git: async (args: string[]) => args[0] === 'ls-tree' ? 'smoke.json' : '',
    trial: async (_commit: string, files: readonly string[], item: { criteria: { proofs: string[] }[] }, ...rest: unknown[]) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      timeouts[proofs.length ? 'catalog' : 'suite'] = rest[6] as number | undefined;
      return { build: 'pass', tests: { passed: 1, failed: [], files: files.length }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
    },
  } as unknown as MergeWriterReads;
  const result = await batchGatePorts({ ...reads, git: reads.git! }, []).diagnose('b'.repeat(40));
  assert.deepEqual(result.failed, []);
  assert.equal(timeouts.catalog, gateCeilingMs, 'the catalog trial may run as long as the gate ceiling');
});
