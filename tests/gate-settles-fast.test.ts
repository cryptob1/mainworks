import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, runGate, type GatePorts } from '../src/batch-gate.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { ServeLanding } from '../src/merge-writer/serve-revert.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3667: a batch gate settles in under 45 minutes. Every failing check that needs the verified
// commit's verdict runs there in one run, the culprit search halves the batch's prefixes, and a
// failing check with an open flaky item is exempted without a rerun.

const repository = 'owner/project';
const item = (key: string, proofs: string[]): Work => ({ id: `work-${key}`, key, title: `${key} change`, description: `${key} change`, type: 'feature', priority: 2,
  criteria: [{ id: 'AC-1', text: `${key} works`, proofs }], mergeLedger: null } as unknown as Work);
const sha = (n: number) => n.toString(16).padStart(2, '0').repeat(20);
const landing = (n: number): ServeLanding => ({ sha: sha(n), before: sha(n - 1), subject: `Merge GY-${n}`, item: item(`GY-${n}`, [`e2e:case-${n}`]) });
const batchOf = (size: number) => Array.from({ length: size }, (_, i) => landing(i + 2));

/** Pure gate ports over `landings`: `fails(commit, check, call)` decides each result; `flaky` names open flaky items by check. */
function gatePorts(landings: ServeLanding[], fails: (commit: string, check: string, call: number) => boolean, flaky: Record<string, string> = {}, tests: string[] = ['test:tests/a.test.ts']) {
  let calls = 0;
  const runs: { commit: string; checks: string[] }[] = [], filed: string[] = [], reverted: string[] = [];
  const ports: GatePorts = {
    now: () => 0,
    fetch: async () => landings.at(-1)!.sha,
    landings: async () => landings,
    files: async () => ['src/a.ts'],
    catalog: async () => ['create-work-item', 'smoke', ...landings.map(entry => `case-${entry.item!.key.slice(3)}`)],
    core: async () => ['create-work-item', 'smoke'],
    run: async (commit, checks) => {
      runs.push({ commit, checks: [...checks] });
      const call = calls++;
      return checks.flatMap(check => check === 'affected' ? tests : [check]).filter(check => fails(commit, check, call));
    },
    revert: async culprit => { reverted.push(culprit.item.key); return { revertSha: 'e'.repeat(40) }; },
    file: async input => { filed.push(input.key); return { item: `GY-${100 + filed.length}` }; },
    flaky: check => flaky[check] ?? null,
  };
  return { ports, runs, filed, reverted };
}

test('integration:gate-probes-in-one-run — several failing checks that need the verified commit\'s verdict run there in one run, each verdict is recorded, and known red and the culprit search decide as before', async () => {
  const verified = sha(1), batch = batchOf(3), tip = batch.at(-1)!.sha;
  const tests = ['test:tests/a.test.ts', 'test:tests/b.test.ts', 'test:tests/c.test.ts'];
  // a and b fail on every commit (known red); c is broken by GY-3 and passes on the verified commit.
  const { ports, runs, filed, reverted } = gatePorts(batch, (commit, check) =>
    check === 'test:tests/a.test.ts' || check === 'test:tests/b.test.ts' || (check === 'test:tests/c.test.ts' && commit !== verified && commit !== sha(2)), {}, tests);
  const record = bootstrapGate(repository, verified);
  const outcome = await runGate(ports, record);
  const probes = runs.filter(entry => entry.commit === verified);
  assert.equal(probes.length, 1, `one run on the verified commit, got ${JSON.stringify(probes)}`);
  assert.deepEqual(probes[0]!.checks.sort(), tests, 'the one run holds every check that needs its verdict');
  assert.deepEqual(record.results[verified], { 'test:tests/a.test.ts': true, 'test:tests/b.test.ts': true, 'test:tests/c.test.ts': false }, 'each check\'s verdict is recorded');
  assert.deepEqual(filed, ['known-red:test:tests/a.test.ts', 'known-red:test:tests/b.test.ts']);
  assert.deepEqual(outcome, { outcome: 'reverted', tip, check: 'test:tests/c.test.ts', culprit: 'GY-3', revertSha: 'e'.repeat(40) });
  assert.deepEqual(reverted, ['GY-3']);
});

test('integration:gate-bisect-halves — the culprit search over N landings runs at most ceil(log2 N)+1 prefix runs and names the last item of the smallest failing prefix, as the linear search did', async () => {
  for (const size of [1, 2, 3, 5, 8, 13]) {
    const batch = batchOf(size), limit = Math.ceil(Math.log2(size)) + 1;
    for (let broken = 0; broken < size; broken++) {
      const from = batch.slice(broken).map(entry => entry.sha);
      const { ports, runs, reverted } = gatePorts(batch, (commit, check) => check === 'e2e:smoke' && from.includes(commit));
      const outcome = await runGate(ports, bootstrapGate(repository, sha(1)));
      assert.equal(outcome.outcome, 'reverted', JSON.stringify(outcome));
      assert.deepEqual(reverted, [batch[broken]!.item!.key], `${size} landings, broken by landing ${broken + 1}`);
      const prefixRuns = runs.slice(2);
      assert.ok(prefixRuns.every(entry => entry.checks.join() === 'e2e:smoke'));
      assert.ok(prefixRuns.length <= limit, `${size} landings broken by landing ${broken + 1}: ${prefixRuns.length} prefix runs, at most ${limit}`);
    }
  }
  // Eight landings: at most four prefix runs, where the linear search took up to seven.
  const batch = batchOf(8), from = batch.slice(7).map(entry => entry.sha);
  const { ports, runs } = gatePorts(batch, (commit, check) => check === 'e2e:smoke' && from.includes(commit));
  await runGate(ports, bootstrapGate(repository, sha(1)));
  assert.ok(runs.slice(2).length <= 4, JSON.stringify(runs.slice(2)));
});

test('integration:gate-known-flaky-no-rerun — a failing check with an open flaky item is exempted without a rerun and the batch kept, its failure recorded on that item; a failing check without one is rerun as today', async () => {
  const verified = sha(1), batch = batchOf(2), tip = batch.at(-1)!.sha;
  // Only the flaky-item check fails: no rerun at all, the batch verifies.
  {
    const { ports, runs, reverted } = gatePorts(batch, (_, check) => check === 'e2e:case-2', { 'e2e:case-2': 'GY-50' });
    const record = bootstrapGate(repository, verified);
    const outcome = await runGate(ports, record);
    assert.equal(outcome.outcome, 'verified', JSON.stringify(outcome));
    assert.equal(runs.length, 1, `the batch's run only, no rerun: ${JSON.stringify(runs)}`);
    assert.deepEqual(reverted, []);
    assert.deepEqual(outcome.outcome === 'verified' && outcome.knownFlaky, [{ check: 'e2e:case-2', item: 'GY-50' }]);
    assert.deepEqual(record.flaky?.['GY-50']?.map(failure => [failure.check, failure.tip]), [['e2e:case-2', tip]]);
    assert.equal(record.lastOutcome?.reason, 'kept the batch: e2e:case-2 failed and has the open flaky item GY-50');
  }
  // Beside it, a check without a flaky item fails once: it alone is rerun, passes, and is filed as a flake.
  {
    const { ports, runs, filed } = gatePorts(batch, (_, check, call) => check === 'e2e:case-2' || (check === 'test:tests/a.test.ts' && call === 0), { 'e2e:case-2': 'GY-50' });
    const outcome = await runGate(ports, bootstrapGate(repository, verified));
    assert.equal(outcome.outcome, 'verified', JSON.stringify(outcome));
    assert.deepEqual(runs.slice(1), [{ commit: tip, checks: ['test:tests/a.test.ts'] }], 'only the check without a flaky item is rerun');
    assert.deepEqual(filed, ['flake:test:tests/a.test.ts']);
  }
});

// The e2e case: real git, the loop's own gate ports, eight landings.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();

test('e2e:gate-settles-fast — a gate with three failing checks, two with open flaky items and one broken by one of eight landings, reverts that landing and settles without timing out', { timeout: 120_000 }, async () => {
  const base = await temporaryDirectory('gate-settles-fast');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  const write = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) { await mkdir(join(pusher, name, '..'), { recursive: true }); await writeFile(join(pusher, name), text); }
    git(pusher, 'add', '.');
  };
  await write({ 'graphyard.json': JSON.stringify({ gate: { core: ['create-work-item', 'smoke', 'flaky-a', 'flaky-b'] } }),
    ...Object.fromEntries(['create-work-item', 'smoke', 'flaky-a', 'flaky-b'].map(id => [`e2e/cases/${id}.json`, '{}'])) });
  git(pusher, 'commit', '-q', '-m', 'base');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  for (let n = 1; n <= 8; n++) {
    git(pusher, 'checkout', '-q', '-b', `item-${n}`);
    await write({ [`src/f${n}.ts`]: n === 6 ? 'broken\n' : 'ok\n' });
    git(pusher, 'commit', '-q', '-m', `change ${n}`);
    git(pusher, 'checkout', '-q', 'main');
    git(pusher, 'merge', '-q', '--no-ff', '-m', `Merge GY-${n}: change ${n}`, `item-${n}`);
  }
  git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const tip = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, coordinator);
  const run = (...args: string[]) => git(coordinator, ...args);
  const work = [...Array.from({ length: 8 }, (_, i) => item(`GY-${i + 1}`, ['unit:x'])),
    ...['flaky-a', 'flaky-b'].map((id, i) => ({ ...item(`GY-5${i}`, ['unit:pinned']), title: `Flaky check on main: e2e:${id}`, stage: 'backlog' }) as unknown as Work)];
  // Smoke fails wherever a source is broken; the two flaky cases fail on every commit.
  const broken = (commit: string) => run('ls-tree', '-r', '--name-only', commit, 'src').split('\n').filter(Boolean).some(file => run('show', `${commit}:${file}`) === 'broken');
  const trials: { commit: string; proofs: string[] }[] = [];
  let clock = Date.parse('2026-11-22T00:00:00Z');
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => clock,
    fetch: async () => { run('fetch', '-q', 'origin', 'main'); return run('rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async (commit, _files, trialItem) => {
      clock += 3 * 60_000; // each trial takes three minutes of the gate's own time
      const proofs = trialItem.criteria.flatMap(criterion => criterion.proofs);
      trials.push({ commit, proofs });
      const failing = ['e2e:flaky-a', 'e2e:flaky-b', ...broken(commit) ? ['e2e:smoke'] : []];
      return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.filter(proof => proof.startsWith('e2e:')).map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: failing.includes(proof) ? 1 : 0 })) } as unknown as MergeTrialRun;
    },
    push: async (commit, baseTip) => { run('push', '-q', `--force-with-lease=main:${baseTip}`, 'origin', `${commit}:main`); return 'pushed'; },
    holds: async () => true,
    record: async () => undefined,
    createWork: async () => ({ key: 'GY-90' }),
  };
  const ports = batchGatePorts({ ...reads, git: reads.git! }, work);
  const record = bootstrapGate(repository, verified);
  const started = clock;
  const outcome = await runGate(ports, record);
  assert.equal(outcome.outcome, 'reverted', JSON.stringify(outcome));
  assert.equal(outcome.outcome === 'reverted' && outcome.culprit, 'GY-6');
  assert.match(run('log', '-1', '--format=%s', 'origin/main'), /^Revert "Merge GY-6/);
  assert.ok(!trials.some(trial => trial.commit === verified), 'no check needed the verified commit');
  const gateTrials = trials.filter(trial => trial.commit !== run('rev-parse', 'origin/main'));
  assert.ok(gateTrials.filter(trial => trial.commit !== tip).length <= 4, `at most four prefix runs over eight landings: ${gateTrials.length}`);
  // The recut keeps the flaky cases exempt and verifies the batch without GY-6.
  const recut = await runGate(ports, record);
  assert.equal(recut.outcome, 'verified', JSON.stringify(recut));
  assert.equal(record.verified, run('rev-parse', 'origin/main'));
  assert.deepEqual((recut.outcome === 'verified' && recut.knownFlaky)?.map?.(flaky => flaky.item), ['GY-50', 'GY-51']);
  assert.ok(clock - started < 45 * 60_000, `the gate settled in ${Math.round((clock - started) / 60_000)} minutes`);
});
