import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bootstrapGate, gateLimitMs, gateRecordPath, readGateRecord, writeGateRecord } from '../src/batch-gate.js';
import { batchGatePorts, batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { localOnlyTestPattern, type HostReading } from '../src/merge-writer/remote-shards.js';
import { trialRunsDirectory, type TrialRunHandle, type TrialRunRequest } from '../src/merge-writer/trial-run.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { until } from './helpers/until.js';

// GY-3974: the 04:23Z diagnostics on b325b3da timed out in this machine's shard after 2700 s. It held
// 263 cases — the 142 only this machine can run and, by count, an equal share of the rest — while one
// test machine ran the other 262 in a single lane. The trials' recorded medians put the tests a
// local-only case runs at 14.7 s and any other's at 3.6 s, and each case pays about 5 s more to start.
// The head's own catalog is placed as the daily run places it and priced that way.

const root = fileURLToPath(new URL('..', import.meta.url));
const text = (file: string) => readFileSync(join(root, file), 'utf8');
const catalog = readdirSync(join(root, 'e2e/cases')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
const delivery = JSON.parse(text('graphyard.json')).delivery ?? {};
const compose = new Set((delivery.applications ?? []).filter((application: { kind: string }) => application.kind === 'compose').map((application: { id: string }) => application.id));
/** The cases only this machine can run: one bound to a Compose application, or one whose text or tests name what a test machine lacks. */
const read = (file: string) => { try { return text(file); } catch { return ''; } };
// GY-4099: a named test is read with the tests/helpers modules it imports, as placement reads it.
const named = (caseText: string) => (caseText.match(/tests\/[\w./-]+\.[cm]?[jt]s/g) ?? []).flatMap(file => {
  const source = read(file);
  return [source, ...[...source.matchAll(/from '\.\/(helpers\/[\w.-]+)\.js'/g)].map(match => read(`tests/${match[1]}.ts`))];
});
const pinned = new Set(catalog.filter(id => {
  const caseText = text(`e2e/cases/${id}.json`);
  return compose.has(delivery.cases?.[id]) || localOnlyTestPattern.test([caseText, ...named(caseText)].join('\n'));
}).map(id => `e2e:${id}`));
const seconds = (cases: readonly string[]) => cases.reduce((sum, proof) => sum + 5 + (pinned.has(proof) ? 14.7 : 3.6), 0);

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
  const msi = 'gy-compute@vish-msi-compute', omarchy = 'gy-compute@omarchypc-compute';
  // vish-msi-compute as the 04:23Z run read it — 10.7 of its 24 cores free, the one ready test machine —
  // then both test machines as they read a day later, then none.
  for (const [found, hosts, shards] of [
    ['one test machine', [reading(msi, 24, 13.3)], { [msi]: 2 }],
    ['two test machines', [reading(msi, 24, 6), reading(omarchy, 40, 8)], { [msi]: 3, [omarchy]: 4 }],
    ['no test machine', [], {}],
  ] as const) {
    const { ran, result } = await placed(hosts);
    const here = ran.filter(shard => shard.host === 'local');
    const longest = [...ran].sort((a, b) => seconds(b.cases) - seconds(a.cases))[0]!;
    assert.ok(seconds(longest.cases) < gateLimitMs / 1000,
      `${found}: the longest shard, on ${longest.host} with ${longest.cases.length} cases, runs ${seconds(longest.cases).toFixed(0)} s: inside 2700 s`);
    assert.deepEqual(ran.flatMap(shard => shard.cases).sort(), catalog.map(id => `e2e:${id}`).sort(), `${found}: every case runs exactly once`);
    assert.deepEqual(result.failed, [], `${found}: nothing fails`);
    for (const shard of here) assert.equal(shard.timeout, gateLimitMs, `${found}: this machine's trial keeps the 45-minute bound`);
    if (hosts.length) {
      assert.ok(here.every(shard => shard.cases.every(proof => pinned.has(proof))), `${found}: this machine keeps only the cases a test machine cannot run`);
      for (const [host, count] of Object.entries(shards)) {
        assert.equal(ran.filter(shard => shard.host === host).length, count, `${found}: ${host} runs one shard per six of its free cores, at most four`);
      }
    }
    assert.deepEqual(result.shards?.map(({ host, cases }) => [host, cases]), ran.map(shard => [shard.host, shard.cases.length]),
      `${found}: the run records where each shard ran and how many cases it held`);
    assert.ok(result.shards?.every(shard => typeof shard.ms === 'number'), `${found}: each recorded shard says how long it ran, so the next slow run names its longest`);
  }
});

test('integration:e2e-catalog-fits-bound — this machine\'s lanes are dealt by the timing baseline: no case in the heavier lane can move without widening the gap', async () => {
  const { files: baseline } = JSON.parse(text('tests/helpers/timing-baseline.json')) as { files: Record<string, number> };
  const recorded = Object.values(baseline).sort((a, b) => a - b), median = recorded[recorded.length >> 1]!;
  // A case weighs its start and the baseline's time for the tests it names; a test the baseline lacks counts as the median.
  const weighs = (proof: string) => 5_000 + [...new Set(text(`e2e/cases/${proof.slice(4)}.json`).match(/tests\/[\w./-]+\.[cm]?[jt]s/g) ?? [])].reduce((sum, file) => sum + (baseline[file] ?? median), 0);
  const { ran } = await placed([reading('gy-compute@vish-msi-compute', 24, 13.3)]);
  const lanes = ran.filter(shard => shard.host === 'local').map(shard => ({ cases: shard.cases, ms: shard.cases.reduce((sum, proof) => sum + weighs(proof), 0) })).sort((a, b) => b.ms - a.ms);
  assert.ok(lanes.length > 1, 'this machine runs its own cases in more than one lane');
  const [heavier, lighter] = lanes as [typeof lanes[0], typeof lanes[0]];
  for (const proof of heavier.cases) assert.ok(weighs(proof) >= heavier.ms - lighter.ms,
    `the lanes hold ${Math.round(heavier.ms / 1000)} s and ${Math.round(lighter.ms / 1000)} s of recorded time: moving ${proof} (${Math.round(weighs(proof) / 1000)} s) would even them out`);
});

const repository = 'owner/project';
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;

test('integration:e2e-catalog-fits-bound — after a loop restart each of this machine\'s lanes adopts its own run, and none starts again', async () => {
  // Eighty cases only this machine can run: two lanes with no test machine added.
  const needsDocker = (index: number) => [`e2e/cases/needs-docker-${index}.json`, '{"steps":[{"kind":"command","run":"docker run"}]}'];
  const { root: checkout, head: verified } = await gitRepo({ label: 'e2e-catalog-lane-adoption', origin: true,
    files: { ...Object.fromEntries(Array.from({ length: 80 }, (_, index) => needsDocker(index))), 'graphyard.json': '{}', 'tests/helpers/timing-baseline.json': '{"files":{}}' } });
  await writeGateRecord(gateRecordPath(checkout), { ...bootstrapGate(repository, verified), diagnosticsAt: '2026-11-18T04:14:18.630Z' });

  const runs = new Map<string, { request: TrialRunRequest; settled: boolean; waiters: ((run: MergeTrialRun) => void)[] }>();
  const launched: string[] = [], adopted: string[] = [];
  let active = 0;
  const passing = (request: TrialRunRequest) => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {},
    e2e: [...request.proofs, ...request.e2eProofs].map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) }) as unknown as MergeTrialRun;
  const watch = (directory: string, loop: number): TrialRunHandle => {
    const entry = runs.get(directory)!;
    return { directory, mergeSha: entry.request.mergeSha,
      trial: () => entry.settled ? Promise.resolve(passing(entry.request)) : new Promise<MergeTrialRun>(resolve => { entry.waiters.push(run => { if (loop === active) resolve(run); }); }),
      detach: () => {}, cancel: () => {} };
  };
  const loop = () => {
    const id = ++active;
    const reads = {
      baseBranch: 'main', now: Date.now,
      fetch: async () => { git(checkout, 'fetch', '-q', 'origin', 'main'); return git(checkout, 'rev-parse', 'origin/main'); },
      git: async (args: string[], extra?: Record<string, string>) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
      trial: async () => { throw new Error('the diagnostics run detached, not in-process'); },
      // The suite ends at once; a lane of the catalog waits.
      launchTrialRun: (request: TrialRunRequest) => {
        const directory = join(trialRunsDirectory(checkout), `diagnostics-${runs.size + 1}`);
        runs.set(directory, { request, settled: request.changedFiles.includes('package.json'), waiters: [] });
        launched.push(directory);
        return watch(directory, id);
      },
      adoptTrialRun: async (ref: { directory: string; mergeSha: string }) => {
        const entry = runs.get(ref.directory);
        if (!entry || entry.request.mergeSha !== ref.mergeSha) return null;
        adopted.push(ref.directory);
        return watch(ref.directory, id);
      },
      push: async () => 'pushed', holds: async () => true, record: async () => undefined, createWork: async () => ({ key: 'GY-900' }),
      gate: { root: checkout, repository },
    } as unknown as MergeWriterReads;
    return { state: emptyDaemonState({ url: 'http://127.0.0.1:1', repository } as never), effects: { mergeWriter: reads } as never, snapshot: { work: [], now: new Date().toISOString() } as never, performed: [], now: Date.now, log: () => {} };
  };

  const first = await batchGateStep(loop());
  await first!.gate;
  await until(() => launched.length === 3, 'the suite and two lanes launch');
  const lanes = launched.slice(1);
  assert.deepEqual(lanes.map(directory => runs.get(directory)!.request.e2eProofs.length), [40, 40], 'the 80 cases run in two lanes of 40');
  await until(() => (readGateRecord(gateRecordPath(checkout))!.diagnosticsTrials ?? []).length === 3, 'the suite and each lane ride the record');

  // A deploy restarts the loop while both lanes run.
  const second = await batchGateStep(loop());
  await second!.gate;
  await until(() => adopted.length >= 3, 'the restarted loop adopts the suite and both lanes');
  assert.deepEqual([...adopted].sort(), [...launched].sort(), 'each lane is adopted by its own run');
  assert.equal(launched.length, 3, 'no lane starts again');

  for (const directory of lanes) {
    const entry = runs.get(directory)!;
    entry.settled = true;
    for (const resolve of entry.waiters.splice(0)) resolve(passing(entry.request));
  }
  await second!.diagnostics;
  const record = readGateRecord(gateRecordPath(checkout))!;
  assert.equal(record.diagnosticsRun?.outcome, 'passed');
  assert.deepEqual(record.diagnosticsRun?.shards?.map(shard => [shard.host, shard.cases]), [['local', 40], ['local', 40]], 'the day\'s run records both lanes');
  assert.deepEqual(record.diagnosticsTrials ?? [], [], 'a finished run leaves no runs to collect');
});

test('integration:e2e-catalog-fits-bound — the shards a test machine runs at once each work in their own checkout, so neither overwrites what the other writes', { timeout: 120_000 }, async () => {
  // A step that writes its served address into its checkout, as the serve writes its seed file (GY-3666), waits for
  // the other shard to write too, and must still read its own.
  const step = "const fs = require('fs'); fs.mkdirSync('.graphyard', { recursive: true }); fs.writeFileSync('.graphyard/serve.json', process.env.TARGET_URL); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); if (fs.readFileSync('.graphyard/serve.json', 'utf8') !== process.env.TARGET_URL) process.exit(1);";
  const { root } = await gitRepo({ label: 'e2e-catalog-own-checkouts', files: {
    'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { 'own-checkout': 'site' } } }),
    'site/index.html': '<h1>fixture</h1>\n',
    'step.cjs': step,
    'e2e/cases/own-checkout.json': JSON.stringify({ id: 'own-checkout', title: 'What a shard writes into its checkout stays its own', tags: ['api'], target: 'any', required: false,
      steps: [{ kind: 'command', name: 'its own write is still there once another shard has written', run: 'node step.cjs', timeoutSeconds: 30 }] }),
  } });
  writeFileSync(join(root, 'list'), 'e2e/cases/own-checkout.json\n');
  const script = fileURLToPath(new URL('../scripts/e2e-shard.mjs', import.meta.url));
  const shard = (name: string) => promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script, 'list', `records-${name}`, '60000'],
    { cwd: root }).catch(() => undefined);
  await Promise.all([shard('one'), shard('two')]);
  for (const name of ['one', 'two']) {
    const entries = (await readFile(join(root, `records-${name}`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(entries.map(entry => [entry.proof, entry.executed, entry.failed, entry.failingStep ?? null]), [['e2e:own-checkout', 1, 0, null]], `shard ${name}: ${JSON.stringify(entries)}`);
  }
  assert.deepEqual(git(root, 'status', '--porcelain').split('\n').filter(Boolean).sort(), ['?? list', '?? records-one', '?? records-two'],
    'the checkout the shards were given holds only what the caller put there');
  assert.equal(git(root, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).length, 1, 'and no worktree of theirs stays registered in it');
});

test('integration:e2e-catalog-fits-bound — a shard that cannot make its worktree fails each of its cases, naming why', { timeout: 120_000 }, async () => {
  const caseFile = (id: string) => JSON.stringify({ id, title: `Case ${id}`, tags: ['api'], target: 'any', required: false, steps: [{ kind: 'command', name: 'nothing to do', run: 'true' }] });
  const { root } = await gitRepo({ label: 'e2e-catalog-worktree-refused', files: {
    'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { first: 'site', second: 'site' } } }),
    'site/index.html': '<h1>fixture</h1>\n',
    'e2e/cases/first.json': caseFile('first'), 'e2e/cases/second.json': caseFile('second'),
  } });
  writeFileSync(join(root, 'list'), 'e2e/cases/first.json\ne2e/cases/second.json\n');
  // A clone whose git directory takes no new worktree.
  writeFileSync(join(root, '.git', 'worktrees'), 'not a directory\n');
  const script = fileURLToPath(new URL('../scripts/e2e-shard.mjs', import.meta.url));
  const ended = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script, 'list', 'records', '60000'], { cwd: root })
    .then(() => null, (error: Error & { code?: number; stderr?: string }) => error);
  assert.ok(ended && ended.code === 1, `the shard ends with its own exit code, not a pass: ${ended?.code}`);
  assert.doesNotMatch(String(ended?.stderr), /\bReferenceError\b/, 'and cleanly, not on an uncaught error of its own');
  const entries = (await readFile(join(root, 'records'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(entries.map(entry => [entry.proof, entry.executed, entry.failed]), [['e2e:first', 0, 1], ['e2e:second', 0, 1]], `every case fails, none as a pass: ${JSON.stringify(entries)}`);
  for (const entry of entries) assert.match(entry.failingStep, /^the shard's worktree of [0-9a-f]{12} failed: .*fatal: could not create leading directories of '\.git\/worktrees\/checkout': Not a directory$/);
});
