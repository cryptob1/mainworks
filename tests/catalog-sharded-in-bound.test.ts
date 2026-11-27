import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateLimitMs, gateSummary, runDiagnostics, bootstrapGate } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { HostReading } from '../src/merge-writer/remote-shards.js';

// GY-3874: the whole catalog took about 55 minutes in one trial on this machine, so GY-3816 raised its
// bound to 90 minutes and it still timed out. The daily run now splits the catalog's cases into shards
// placed on the ready test machines and this one, as a merge trial places its test-file shards, and
// the catalog is bounded by the 45-minute limit again.
// GY-3974: this machine, the slowest and busiest one, keeps only the cases a test machine cannot run.

const reading = (name: string): HostReading => ({ name, cores: 8, busy: 0, steal: 0, celsius: null, limit: 90, away: false });

test('integration:catalog-sharded-in-bound — the diagnostics split the catalog across two ready hosts and this machine, bounded by 45 minutes, and record the shards', async () => {
  const ids = Array.from({ length: 9 }, (_, index) => `case-${index + 1}`);
  const local: { cases: string[]; timeout: number | undefined }[] = [], remote: Record<string, string[]> = {};
  let deadline = 0;
  const reads = {
    baseBranch: 'main', now: Date.now, fetch: async () => 'a'.repeat(40),
    // case-1 needs Docker, so only this machine can run it; the other eight may run anywhere.
    git: async (args: string[]) => args[0] === 'ls-tree' ? ids.map(id => `${id}.json`).join('\n') : args[1] === 'b'.repeat(40) + ':e2e/cases/case-1.json' ? '{"steps":[{"kind":"command","run":"docker run"}]}' : '',
    trial: async (_commit: string, files: readonly string[], item: { criteria: { proofs: string[] }[] }, ...rest: unknown[]) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      if (proofs.length) local.push({ cases: proofs, timeout: rest[6] as number | undefined });
      return { build: 'pass', tests: { passed: 1, failed: [], files: files.length }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
    },
    gate: {
      root: '/nowhere', repository: 'o/r',
      catalogHosts: async (_commit: string, until: number) => {
        deadline = until;
        return { hosts: [reading('host-a'), reading('host-b')], close: async () => {},
          run: async (host: string, _index: number, cases: readonly string[]) => {
            remote[host] = [...cases];
            return cases.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: proof === 'e2e:case-2' ? 1 : 0, ...(proof === 'e2e:case-2' ? { failingStep: 'step one failed' } : {}) }));
          } };
      },
    },
  } as unknown as MergeWriterReads;
  const started = Date.now();
  const ports = batchGatePorts({ ...reads, git: reads.git! }, []);
  const result = await ports.diagnose('b'.repeat(40));

  assert.equal(local.length, 1, 'this machine runs one lane of the catalog: its own case');
  assert.equal(local[0]!.timeout, gateLimitMs, 'the catalog is bounded by the 45-minute limit');
  assert.equal(gateLimitMs, 45 * 60_000);
  assert.ok(deadline - started <= gateLimitMs + 1_000 && deadline - started >= gateLimitMs - 1_000, 'the remote shards share the 45-minute deadline');
  assert.deepEqual(local[0]!.cases, ['e2e:case-1'], 'the case needing Docker runs on this machine and nowhere else');
  assert.ok(remote['host-a']?.length && remote['host-b']?.length, 'each host runs cases');
  const all = [...local[0]!.cases, ...remote['host-a']!, ...remote['host-b']!];
  assert.deepEqual([...all].sort(), ids.map(id => `e2e:${id}`).sort(), 'every case runs exactly once');
  assert.deepEqual(result.failed, ['e2e:case-2'], 'a remote shard’s failing case is the diagnostics’ failure');
  assert.equal(result.details?.['e2e:case-2'], 'step one failed');
  assert.deepEqual(result.shards?.map(shard => shard.cases).reduce((sum, count) => sum + count, 0), ids.length);
  assert.deepEqual(new Set(result.shards?.map(shard => shard.host)), new Set(['host-a', 'host-b', 'local']));

  const record = { ...bootstrapGate('o/r', 'b'.repeat(40)), verified: 'b'.repeat(40) };
  await runDiagnostics({ now: Date.now, file: async () => ({ key: 'GY-1' }), diagnose: async () => result } as never, record);
  assert.deepEqual(record.diagnosticsRun?.shards, result.shards, 'the day’s run records its shards');
  assert.deepEqual(gateSummary(record)?.diagnostics?.shards, result.shards, 'master status shows where the catalog ran');
  assert.ok(record.diagnosticsAt, 'the catalog run finishes and is recorded');
});

test('integration:catalog-sharded-in-bound — with no host added, this machine runs the whole catalog within 45 minutes', async () => {
  let timeout: number | undefined, cases: string[] = [];
  const reads = {
    baseBranch: 'main', now: Date.now, fetch: async () => 'a'.repeat(40),
    git: async (args: string[]) => args[0] === 'ls-tree' ? 'smoke.json\nother.json' : '',
    trial: async (_commit: string, files: readonly string[], item: { criteria: { proofs: string[] }[] }, ...rest: unknown[]) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      if (proofs.length) { timeout = rest[6] as number | undefined; cases = proofs; }
      return { build: 'pass', tests: { passed: 1, failed: [], files: files.length }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
    },
  } as unknown as MergeWriterReads;
  const result = await batchGatePorts({ ...reads, git: reads.git! }, []).diagnose('b'.repeat(40));
  assert.deepEqual(result.failed, []);
  assert.equal(timeout, gateLimitMs);
  assert.deepEqual(cases.sort(), ['e2e:other', 'e2e:smoke']);
});

test('integration:catalog-sharded-in-bound — a Compose-bound case stays on this machine, a left-out case is no failure, and an empty shard goes to no host', async () => {
  const config = JSON.stringify({ delivery: { applications: [{ id: 'app', kind: 'compose' }], cases: { 'compose-case': 'app' } } });
  const local: string[] = [], remote: Record<string, string[]> = {};
  const reads = {
    baseBranch: 'main', now: Date.now, fetch: async () => 'a'.repeat(40),
    git: async (args: string[]) => args[0] === 'ls-tree' ? 'compose-case.json\nleft-out.json' : args[1]?.endsWith(':graphyard.json') ? config : '',
    trial: async (_commit: string, files: readonly string[], item: { criteria: { proofs: string[] }[] }) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      local.push(...proofs);
      return { build: 'pass', tests: { passed: 1, failed: [], files: files.length }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
    },
    gate: {
      root: '/nowhere', repository: 'o/r',
      catalogHosts: async () => ({ hosts: [reading('host-a'), reading('host-b')], close: async () => {},
        run: async (host: string, _index: number, cases: readonly string[]) => {
          if (!cases.length) throw new Error('run-shard refuses an empty shard');
          remote[host] = [...cases];
          return [];
        } }),
    },
  } as unknown as MergeWriterReads;
  const result = await batchGatePorts({ ...reads, git: reads.git! }, []).diagnose('b'.repeat(40));
  assert.deepEqual(local, ['e2e:compose-case'], 'the Compose-bound case runs on this machine');
  assert.deepEqual(Object.values(remote), [['e2e:left-out']], 'one host runs the other case and the empty shard is sent nowhere');
  assert.deepEqual(result.failed, [], 'a case the shard leaves out is no failure');
});
