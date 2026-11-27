import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { slotsDirectoryVariable, writeMachines, type Machine } from '../src/master/verification-slots.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { masterConfigSchema } from '../src/master/profiles.js';

// GY-3722: the shard-placement alert said this machine was overloaded beside an idle host but not
// what ran here, and the confined master cannot list processes. The loop now names the five local
// jobs using the most CPU, each with its item and kind, in the alert master status shows.

const machines = (localBusy: number): Machine[] => [
  { name: 'vishrog', local: true, away: false, cores: 24, busy: localBusy, celsius: 61 },
  { name: 'gy-compute@omarchypc-compute:2222', away: false, cores: 32, busy: 0, celsius: 50 },
];

async function statusFixture(name: string) {
  const root = await temporaryDirectory(name), directory = join(await temporaryDirectory(`${name}-data`), 'heavy-jobs');
  mkdirSync(directory);
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, '.graphyard'));
  const credentialFile = join(root, 'token');
  writeFileSync(credentialFile, 'fixture-token', { mode: 0o600 });
  const master = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', cliPath: process.execPath, repository: 'acme/app', baseBranch: 'main', hostId: 'loop-host',
    masterAgentName: 'graphyard-master-app', workers: [], credentialFile, run: {} }) as never;
  writeFileSync(join(root, '.graphyard/master.json'), JSON.stringify(master), { mode: 0o600 });
  const alert = async (now: Date) => {
    const previous = process.env[slotsDirectoryVariable];
    process.env[slotsDirectoryVariable] = directory;
    try {
      const report = await masterStatusReport(root, master, async () => ({ work: [], now: now.toISOString() }), async () => { throw new Error('no git in the fixture'); });
      return report.attention.filter(line => line.subject === 'shard placement').map(line => line.text);
    } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
  };
  return { root, directory, alert };
}

/** A /proc with one process per job kind; `ticks` is each one's CPU time so far. */
function writeProc(proc: string, root: string, ticks: (pid: number) => number) {
  const processes: [number, string, string][] = [
    [101, join(root, '.graphyard/worktrees/GY-3701-1'), 'claude --print'],
    [102, join(root, '.graphyard/worktrees/GY-3702-2/src'), 'node node_modules/vitest/vitest.mjs run'],
    [103, '/var/tmp/graphyard/graphyard-trial-gy-3703-abcdef1-0123abcd/checkout', 'node tests/helpers/run-tests.ts'],
    [104, '/var/tmp/graphyard/graphyard-trial-batch-gate-abcdef1-0123abcd/checkout', 'node tests/helpers/run-tests.ts'],
    [105, '/var/tmp/graphyard/graphyard-review-gy-3705-abcdef1-0123abcd/checkout', 'codex exec'],
    [106, '/', '/usr/bin/herdr-server --listen'],
    [107, '/', '/usr/bin/sleep 100'],
  ];
  for (const [pid, cwd, command] of processes) {
    const folder = join(proc, String(pid));
    mkdirSync(folder, { recursive: true });
    // Fields after the command: state ppid ... utime (14th) stime (15th) ... starttime (22nd).
    const fields = ['S', '1', ...Array(9).fill('0'), String(ticks(pid)), '0', ...Array(6).fill('0'), '5000'];
    writeFileSync(join(folder, 'stat'), `${pid} (${command.split(' ')[0]!.split('/').pop()}) ${fields.join(' ')}\n`);
    writeFileSync(join(folder, 'cmdline'), command.split(' ').join('\0'));
    try { symlinkSync(cwd, join(folder, 'cwd')); } catch { /* already there */ }
  }
}

test('integration:placement-alert-names-load — while this machine is overloaded beside an idle host, the alert in master status names the five busiest local jobs with their CPU, item and kind; otherwise nothing changes', { timeout: 60_000 }, async () => {
  const { root, directory, alert } = await statusFixture('placement-alert-names-load');
  const proc = join(await temporaryDirectory('placement-alert-names-load-proc'), 'proc');
  // Cores each process uses over the six minutes between readings (100 ticks a second).
  const cores: Record<number, number> = { 101: 1, 102: 6, 103: 9.5, 104: 3, 105: 0.5, 106: 2, 107: 0 };
  const start = new Date(), later = new Date(start.getTime() + 6 * 60_000);
  writeProc(proc, root, () => 1000);
  writeMachines(directory, machines(125), start, proc);
  writeProc(proc, root, pid => 1000 + cores[pid]! * 100 * 360);
  writeMachines(directory, machines(125), later, proc);
  const lines = await alert(later);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'This machine is at load 125 on 24 cores while omarchypc-compute has 32 of 32 cores free, for 6 minutes. '
    + 'Busiest here: GY-3703 merge trial 9.5 cores, GY-3702 builder test run 6.0 cores, none batch gate 3.0 cores, none other (herdr-server) 2.0 cores, GY-3701 builder session 1.0 cores.');

  // Back under its cores: no alert, and no jobs.
  writeMachines(directory, machines(10), later, proc);
  assert.deepEqual(await alert(later), []);
});

test('integration:placement-alert-names-load — a busy process in a builder worktree is read from this machine\'s own processes and named by its item and kind', { timeout: 60_000 }, async () => {
  const { root, directory, alert } = await statusFixture('placement-alert-names-load-live');
  const worktree = join(root, '.graphyard/worktrees/GY-9722-1');
  mkdirSync(worktree, { recursive: true });
  const busy = spawn(process.execPath, ['-e', 'for (;;) {}'], { cwd: worktree, stdio: 'ignore' });
  try {
    // The imbalance began six minutes ago; the last two readings are two seconds apart.
    writeMachines(directory, machines(30), new Date(Date.now() - 6 * 60_000));
    writeMachines(directory, machines(30));
    await new Promise(done => setTimeout(done, 2_000));
    const now = new Date();
    writeMachines(directory, machines(30), now);
    const lines = await alert(now);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /Busiest here: .*GY-9722 builder session [\d.]+ cores/);
  } finally { busy.kill('SIGKILL'); }
});
