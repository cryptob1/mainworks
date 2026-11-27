import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateLimitMs } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { localOnlyTestPattern, type HostReading } from '../src/merge-writer/remote-shards.js';

// GY-3974: the 04:23Z diagnostics on b325b3da timed out in this machine's shard after 2700 s. It held
// 263 cases — the 142 only this machine can run and, by count, an equal share of the rest — while one
// test machine ran the other 262 in a single lane. The trials' recorded medians put the tests a
// local-only case runs at 14.8 s and any other's at 3.6 s, and each case pays about 5 s more to start:
// 20 s and 5 s a case here. The head's own catalog is placed as the daily run places it.

const root = fileURLToPath(new URL('..', import.meta.url));
const text = (file: string) => readFileSync(join(root, file), 'utf8');
const catalog = readdirSync(join(root, 'e2e/cases')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
const delivery = JSON.parse(text('graphyard.json')).delivery ?? {};
const compose = new Set((delivery.applications ?? []).filter((application: { kind: string }) => application.kind === 'compose').map((application: { id: string }) => application.id));
/** The cases only this machine can run: one bound to a Compose application, or one whose text or tests name what a test machine lacks. */
const named = (caseText: string) => (caseText.match(/tests\/[\w./-]+\.[cm]?[jt]s/g) ?? []).map(file => { try { return text(file); } catch { return ''; } });
const pinned = new Set(catalog.filter(id => {
  const caseText = text(`e2e/cases/${id}.json`);
  return compose.has(delivery.cases?.[id]) || localOnlyTestPattern.test([caseText, ...named(caseText)].join('\n'));
}).map(id => `e2e:${id}`));
const seconds = (cases: readonly string[]) => cases.reduce((sum, proof) => sum + (pinned.has(proof) ? 20 : 5), 0);

const passing = (proofs: readonly string[]) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 0 }, durationMs: 1, logTail: '', files: [], proofs: {},
  e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) }) as unknown as MergeTrialRun;
const reading = (name: string, cores: number, busy: number): HostReading => ({ name, cores, busy, steal: 0, celsius: null, limit: 90, away: false });

/** The head's catalog diagnosed over `hosts`: each shard as it ran, with the bound this machine's trials were given. */
async function placed(hosts: readonly HostReading[]) {
  const ran: { host: string; cases: string[]; timeout?: number }[] = [];
  const reads = {
    baseBranch: 'main', now: Date.now, fetch: async () => 'a'.repeat(40),
    git: async (args: string[]) => args[0] === 'ls-tree' ? catalog.map(id => `${id}.json`).join('\n') : text(args[1]!.slice(args[1]!.indexOf(':') + 1)),
    trial: async (_commit: string, _files: readonly string[], item: { criteria: { proofs: string[] }[] }, ...rest: unknown[]) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      if (proofs.length) ran.push({ host: 'local', cases: proofs, timeout: rest[6] as number | undefined });
      return passing(proofs);
    },
    gate: { root, repository: 'o/r',
      catalogHosts: async () => ({ hosts: [...hosts], close: async () => {},
        run: async (host: string, _index: number, cases: readonly string[]) => { ran.push({ host, cases: [...cases] }); return passing(cases).e2e; } }) },
  } as unknown as MergeWriterReads;
  return { ran, result: await batchGatePorts({ ...reads, git: reads.git! }, []).diagnose('b'.repeat(40)) };
}

test('integration:e2e-catalog-fits-bound — the whole catalog ends inside 45 minutes on this machine and on the test machines, as the 04:23Z run found them', async () => {
  assert.equal(gateLimitMs, 45 * 60_000, 'the 45-minute bound stays');
  // vish-msi-compute as the 04:23Z run read it — 10.7 of its 24 cores free, the one ready test machine — then none.
  for (const [named, hosts] of [['one test machine', [reading('gy-compute@vish-msi-compute', 24, 13.3)]], ['no test machine', []]] as const) {
    const { ran, result } = await placed(hosts);
    const here = ran.filter(shard => shard.host === 'local');
    const longest = [...ran].sort((a, b) => seconds(b.cases) - seconds(a.cases))[0]!;
    assert.ok(seconds(longest.cases) < gateLimitMs / 1000,
      `${named}: the longest shard, on ${longest.host} with ${longest.cases.length} cases, runs ${seconds(longest.cases)} s: inside 2700 s`);
    assert.deepEqual(ran.flatMap(shard => shard.cases).sort(), catalog.map(id => `e2e:${id}`).sort(), `${named}: every case runs exactly once`);
    assert.deepEqual(result.failed, [], `${named}: nothing fails`);
    for (const shard of here) assert.equal(shard.timeout, gateLimitMs, `${named}: this machine's trial keeps the 45-minute bound`);
    if (hosts.length) {
      assert.ok(here.every(shard => shard.cases.every(proof => pinned.has(proof))), `${named}: this machine keeps only the cases a test machine cannot run`);
      assert.ok(ran.some(shard => shard.host !== 'local'), `${named}: a test machine takes the rest`);
    }
    assert.deepEqual(result.shards?.map(({ host, cases }) => [host, cases]), ran.map(shard => [shard.host, shard.cases.length]),
      `${named}: the run records where each shard ran and how many cases it held`);
    assert.ok(result.shards?.every(shard => typeof shard.ms === 'number'), `${named}: each recorded shard says how long it ran, so the next slow run names its longest`);
  }
});
