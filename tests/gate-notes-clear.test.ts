import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, gateChecks, gateRecordPath, gateSummary, mergeFilings, readGateRecord, writeGateRecord, type GateRecord } from '../src/batch-gate.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { batchGateStep } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import type { MasterConfig } from '../src/master.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import type { ServeLanding } from '../src/merge-writer/serve-revert.js';
import type { Work } from '../src/model.js';
import { mainworksRepository } from '../src/scenarios.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const start = Date.parse('2030-06-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const passing = { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {}, e2e: [] } as unknown as MergeTrialRun;

async function gateWorld(label: string, pushVerified: (commit: string, origin: string, coordinator: string) => Promise<void>) {
  const base = await temporaryDirectory(label);
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), coordinator = join(base, 'coordinator');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await writeFile(join(pusher, 'graphyard.json'), '{}');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'base'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const verified = git(pusher, 'rev-parse', 'HEAD');
  const commit = async (file: string, content: string, message: string) => {
    await writeFile(join(pusher, file), content);
    git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', message); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    return git(pusher, 'rev-parse', 'HEAD');
  };
  git(base, 'clone', '-q', origin, coordinator);
  await mkdir(join(coordinator, '.graphyard'), { recursive: true });
  const file = gateRecordPath(coordinator);
  await writeGateRecord(file, { ...bootstrapGate(mainworksRepository, verified), diagnosticsAt: iso(start) });
  const reads: MergeWriterReads = {
    baseBranch: 'main', now: () => start, cores: 2, parallel: 1,
    fetch: async () => { git(coordinator, 'fetch', '-q', 'origin', 'main'); return git(coordinator, 'rev-parse', 'origin/main'); },
    git: async (args, extra) => execFileSync('git', ['-C', coordinator, ...args], { encoding: 'utf8', env: { ...env, ...extra } }),
    merge: async () => { throw new Error('unused'); },
    trial: async () => passing,
    push: async () => 'pushed',
    pushVerified: sha => pushVerified(sha, origin, coordinator),
    holds: async () => true,
    record: async () => undefined,
    gate: { root: coordinator, repository: mainworksRepository },
  };
  const step = async () => {
    const state = emptyDaemonState({ url: 'http://127.0.0.1:1', repository: mainworksRepository } as any);
    const flight = (await batchGateStep({ state, effects: { mergeWriter: reads } as any, snapshot: { work: [], now: iso(start) } as any, now: () => start, log: () => {} }))!;
    await flight.gate;
    await flight.diagnostics;
  };
  return { origin, coordinator, file, verified, commit, step };
}

test('integration:gate-notes-clear — a failed verified-ref push leaves a note, the next successful push removes it, and an unrelated note stays', { timeout: 60_000 }, async () => {
  const unrelated = 'diagnostic:e2e:board: the control plane is down';
  let shouldFail = true;
  const world = await gateWorld('gate-notes-clear-integration', async (sha, _origin, coordinator) => {
    if (shouldFail) throw new Error('Command failed: git push origin refs/graphyard/verified');
    git(coordinator, 'push', '-q', 'origin', `${sha}:refs/graphyard/verified`);
  });
  const seed = readGateRecord(world.file)!;
  seed.notes = [unrelated];
  await writeGateRecord(world.file, seed);

  // Batch 1 verifies, but publishing refs/graphyard/verified fails -> verified-ref note is recorded beside the unrelated note.
  const tip1 = await world.commit('f1.ts', 'one\n', 'change 1');
  await world.step();
  const afterFail = readGateRecord(world.file)!;
  assert.equal(afterFail.verified, tip1);
  assert.ok(afterFail.notes?.some(note => note.startsWith('verified-ref: ')), 'failed push leaves a verified-ref note');
  assert.ok(afterFail.notes?.includes(unrelated), 'unrelated note stays');

  // Next cycle: catch-up publish succeeds -> verified-ref note clears, unrelated note stays.
  shouldFail = false;
  await world.step();
  const afterHeal = readGateRecord(world.file)!;
  assert.equal(afterHeal.published, tip1);
  assert.equal(git(world.origin, 'rev-parse', 'refs/graphyard/verified'), tip1);
  assert.ok(!afterHeal.notes?.some(note => note.startsWith('verified-ref: ')), 'successful catch-up push removes verified-ref note');
  assert.ok(afterHeal.notes?.includes(unrelated), 'unrelated note stays after catch-up push');

  // Batch 2 fails publish, then Batch 3 succeeds during runGate -> verified-ref note clears and mergeFilings does not resurrect it.
  shouldFail = true;
  const tip2 = await world.commit('f2.ts', 'two\n', 'change 2');
  await world.step();
  assert.ok(readGateRecord(world.file)!.notes?.some(note => note.startsWith('verified-ref: ')), 'second failed push records verified-ref note');
  assert.equal(readGateRecord(world.file)!.verified, tip2);

  // Simulate a concurrent diagnostics snapshot taken while the note was present; merging must not resurrect it after the gate clears it.
  const staleDiagnosticsSnapshot = readGateRecord(world.file)!;
  shouldFail = false;
  const tip3 = await world.commit('f3.ts', 'three\n', 'change 3');
  await world.step();
  const afterTip3 = readGateRecord(world.file)!;
  assert.equal(afterTip3.verified, tip3);
  assert.equal(afterTip3.published, tip3);
  assert.ok(!afterTip3.notes?.some(note => note.startsWith('verified-ref: ')), 'successful gate publish removes verified-ref note');
  assert.ok(afterTip3.notes?.includes(unrelated), 'unrelated note stays after gate publish');
  const merged = mergeFilings(afterTip3, staleDiagnosticsSnapshot, 'diagnostics');
  assert.ok(!merged.notes?.some(note => note.startsWith('verified-ref: ')), 'diagnostics merge does not resurrect cleared verified-ref note');
  assert.ok(merged.notes?.includes(unrelated), 'diagnostics merge keeps unrelated diagnostic note');

  // Skipped bound case note clears when the case returns to the catalog, while unrelated notes stay.
  const landing = (sha: string, key: string, proof: string) => ({ sha, before: '', subject: key, item: { key, criteria: [{ id: 'AC-1', text: '', proofs: [proof] }] } as unknown as Work }) as ServeLanding;
  const checkRecord = { merges: [], notes: [unrelated] } as unknown as Pick<GateRecord, 'merges' | 'notes'>;
  await gateChecks({ catalog: async () => ['smoke'], core: async () => ['smoke'] }, checkRecord, 'tip', [landing('1'.repeat(40), 'GY-1', 'e2e:gone')], false);
  assert.ok(checkRecord.notes?.some(note => note.startsWith('gone: ')), 'skipped bound case records a note');
  assert.ok(checkRecord.notes?.includes(unrelated), 'unrelated note stays beside skipped-case note');
  await gateChecks({ catalog: async () => ['gone', 'smoke'], core: async () => ['smoke'] }, checkRecord, 'tip', [landing('1'.repeat(40), 'GY-1', 'e2e:gone')], false);
  assert.ok(!checkRecord.notes?.some(note => note.startsWith('gone: ')), 'skipped-case note clears once the case is back in the catalog');
  assert.ok(checkRecord.notes?.includes(unrelated), 'unrelated note stays after skipped-case note clears');
});

test('e2e:gate-notes-clear — on a running test install a verified commit with a successful verified-ref push shows no verified-ref note in master status', { timeout: 60_000 }, async () => {
  let shouldFail = true;
  const world = await gateWorld('gate-notes-clear-e2e', async (sha, _origin, coordinator) => {
    if (shouldFail) throw new Error('Command failed: git push origin refs/graphyard/verified');
    git(coordinator, 'push', '-q', 'origin', `${sha}:refs/graphyard/verified`);
  });
  const credentials = await temporaryDirectory('gate-notes-clear-credentials');
  const master = {
    url: 'http://127.0.0.1:1',
    repository: mainworksRepository,
    credentialFile: join(credentials, 'coordinator.token'),
    hostId: 'yard-box',
    baseBranch: 'main',
    workers: [],
    run: { intervalSeconds: 30 },
  } as unknown as MasterConfig;
  await writeFile(daemonStatePath(master), JSON.stringify({ version: 1, url: master.url, repository: master.repository }));
  const status = () => masterStatusReport(world.coordinator, master, async () => ({ work: [], now: iso(start) }), async (command, args) => command === 'git' ? git(world.coordinator, ...args.slice(2)) : '');

  const tip = await world.commit('app.ts', 'export const ok = true;\n', 'verified change');
  await world.step();
  const whileFailed = await status();
  assert.equal(whileFailed.batchGate?.verified, tip.slice(0, 12));
  assert.ok(whileFailed.batchGate?.notes.some(note => note.startsWith('verified-ref: ')), 'master status shows the verified-ref note while the push has failed');

  shouldFail = false;
  await world.step();
  assert.equal(git(world.origin, 'rev-parse', 'refs/graphyard/verified'), tip, 'refs/graphyard/verified points at the verified commit');
  const afterPush = await status();
  assert.equal(afterPush.batchGate?.verified, tip.slice(0, 12));
  assert.ok(!afterPush.batchGate?.notes.some(note => note.startsWith('verified-ref: ')), 'master status shows no verified-ref note once the push succeeds');
  assert.deepEqual(gateSummary(readGateRecord(world.file))?.notes, []);
});
