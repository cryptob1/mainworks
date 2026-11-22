import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import { runDaemon } from '../src/daemon/run.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3642: a merge, a finished trial or an accepted submission the loop itself wrote wakes it
// within one poll; the loop's own persist write never does. The clock is fake: every pause moves it.

test('unit:own-merge-events-wake-the-loop — the loop\'s own merge, finished trial and accepted submission wake it within 2 s; its own persist write waits out the interval', async () => {
  const credentials = await temporaryDirectory('own-merge-events-wake');
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: '/bin/true',
    repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, workers: [] });
  const self = 'coordinator-loop', interval = 60_000;
  const ledger: { seq: number; actor: string; kind: string }[] = [{ seq: 1, actor: 'worker-old', kind: 'submit' }];
  const written: number[] = [];
  const write = (kind: string) => { written.push(clock); ledger.push({ seq: ledger.length + 1, actor: self, kind }); };
  // What the loop writes during each pause after the cycle at that index, and the cycle instants.
  const script: (string | null)[] = ['loop-state.saved', 'merge.pushed', 'merge.trial', 'submit', 'merge.reconciled'];
  const cycles: number[] = [];
  let clock = 0, pending: string | null = null;
  const host = new EventEmitter() as unknown as NodeJS.Process;
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {},
    snapshot: async () => {
      cycles.push(clock);
      pending = script[cycles.length - 1] ?? null;
      if (cycles.length > script.length) host.emit('SIGTERM');
      return { work: [], now: new Date(clock).toISOString() };
    },
    persist: current => writeDaemonState(config, current),
  };
  await runDaemon(config, emptyDaemonState(config), effects, { intervalMs: interval, identity: { pid: process.pid, host: 'machine-a' }, process: host, log: () => {}, now: () => clock,
    delay: async ms => { clock += ms; if (pending) { write(pending); pending = null; } await Promise.resolve(); },
    events: { read: async () => [...ledger].reverse(), self, pollMs: 2_000 } });
  const gaps = cycles.slice(1).map((at, index) => at - cycles[index]);
  assert.equal(gaps[0], interval, `the loop's own persist write does not wake it: it waits out the ${interval} ms interval (${gaps.join(', ')})`);
  for (const [index, kind] of script.slice(1).entries())
    assert.ok(cycles[index + 2] - written[index + 1] <= 2_000, `the loop's own ${kind} wakes it within 2 s of being written, not after the interval (cycles ${cycles.join(', ')}; writes ${written.join(', ')})`);
});
