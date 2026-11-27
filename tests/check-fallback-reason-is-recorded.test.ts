import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { slotsDirectoryVariable, writeMachines } from '../src/master/verification-slots.js';
import type { ShardSshSession } from '../src/merge-writer/remote-shards.js';
import { trialRunFiles, trialRunsDirectory } from '../src/merge-writer/trial-run.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardRepository } from './helpers/shard-hosts.js';

// GY-3704: a check with services that falls back from a compute host to this machine records why in
// the run's steps.jsonl, and master status shows the host's last fallback beside its load line until
// a check next runs there.

const target = 'gy-compute@box', stderr = 'gy-compute@box: Permission denied (publickey).';

test('unit:check-fallback-reason-is-recorded — a host whose SSH fails leaves its reason in steps.jsonl and in master status beside its load line', { timeout: 240_000 }, async () => {
  const repository = await shardRepository('fallback-reason-repo', [], {
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'db', command: 'node scripts/db.mjs', source: 'script', reason: 'fixture',
      services: [{ file: 'compose.json', service: 'postgres', port: 5432 }] }] } } }),
    'compose.json': JSON.stringify({ services: { postgres: { image: 'postgres:16' } } }),
    'scripts/db.mjs': 'process.exit(0)\n',
  });
  const directory = join(trialRunsDirectory(repository.root), 'run-1'), steps = trialRunFiles(directory).steps;
  mkdirSync(directory, { recursive: true });
  const local: string[][] = [];
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    if (command === 'node') { local.push(args); return 'ok'; }
    if (command === 'docker') return 'sha256:3704';
    return defaultChildRun(command, args, options);
  };
  const transport = { session: async () => { throw Object.assign(new Error('ssh exited 255'), { stderr }); }, close: async () => {} } as unknown as ShardSshSession;
  const ready = { cores: 8, busy: 0, steal: 0, celsius: null, limit: 90, away: false };
  const result = await runTrial({ root: repository.root, base: await temporaryDirectory('fallback-reason-base'), mergeSha: repository.sha, changedFiles: ['scripts/db.mjs'], timeoutMs: 120_000, cores: 2, run, retries: 0,
    services: async () => ({ network: 'container:local-postgres', close: async () => {} }),
    onHostCheck: entry => appendFileSync(steps, `${JSON.stringify({ ...entry, at: '2026-11-22T07:00:00.000Z' })}\n`),
    remote: { hosts: [target], transport, read: async () => [{ name: 'here', ...ready }, { name: target, ...ready, compose: true }] } });
  assert.deepEqual(result.tests, { passed: 1, failed: [], files: 1 }, result.logTail);
  assert.equal(local.filter(args => args.includes('scripts/db.mjs')).length, 1, 'the check ran on this machine');

  const records = readFileSync(steps, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(records, [{ check: 'db', host: target, fallback: `host ${target} dropped a shard: ${stderr}`, at: '2026-11-22T07:00:00.000Z' }]);

  const heavy = join(await temporaryDirectory('fallback-reason-heavy'), 'heavy-jobs'), previous = process.env[slotsDirectoryVariable];
  writeMachines(heavy, [{ name: 'this machine', local: true, away: false, cores: 24, busy: 2, celsius: null }, { name: target, away: false, cores: 8, busy: 1, celsius: null }]);
  const master = { url: 'http://127.0.0.1:5', repository: 'owner/fixture', credentialFile: join(heavy, 'coordinator.token'), hostId: 'yard-box', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const machines = async () => (await masterStatusReport(repository.root, master, async () => ({ work: [], now: new Date().toISOString() }), async () => '')).heavyJobs.machines;
  process.env[slotsDirectoryVariable] = heavy;
  try {
    assert.deepEqual(await machines(), ['this machine: 2 of 24 cores busy',
      `box: 1 of 8 cores busy, 0 shards · last check fell back to this machine at 2026-11-22T07:00:00.000Z: host ${target} dropped a shard: ${stderr}`]);
    appendFileSync(steps, `${JSON.stringify({ check: 'db', host: target, at: '2026-11-22T07:10:00.000Z' })}\n`);
    assert.deepEqual(await machines(), ['this machine: 2 of 24 cores busy', 'box: 1 of 8 cores busy, 0 shards'], 'a check that next runs there clears it');
  } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
});
