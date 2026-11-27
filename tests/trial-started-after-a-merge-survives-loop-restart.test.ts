import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pipelineWorld } from './helpers/pipeline-world.js';
import { trialRunsDirectory, stopTrialRun } from '../src/merge-writer/trial-run.js';
import type { DaemonState } from '../src/daemon/state.js';

// GY-3965: a merge landing in a cycle no longer holds the next trial back. With one trial slot, the
// waiting head's trial starts in the cycle the first head lands; a loop restarted onto a new release
// while it runs adopts it and reaches its verdict without running it twice.
const waitFor = async <T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, ms = 60000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(Date.now() - start < ms, label + ': ' + JSON.stringify(value));
    await delay(100);
  }
};

test('integration:trial-started-after-a-merge-survives-loop-restart — the trial a merge-landing cycle starts is adopted after a restart and runs once', { timeout: 180000 }, async () => {
  const world = await pipelineWorld('trial-after-merge-restart');
  const cursor = join(world.root, 'cursor.json');
  await mkdir(world.trials, { recursive: true });
  const first = await world.submit('First', { 'first.txt': 'first\n' });
  const second = await world.submit('Second', { 'second.txt': 'second\n' });
  let child: ChildProcess | undefined, errors = '';
  const start = () => {
    // Two cores: one trial slot, so the second head waits for the first to land.
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/trial-restart-process.ts', import.meta.url)),
      JSON.stringify({ checkout: world.checkout, trials: world.trials, url: world.url, config: world.config, database: world.database, cursor, cores: 2 })],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr!.on('data', data => { errors += data; });
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child!.kill('SIGKILL'), 2000);
    await exited; clearTimeout(timer);
  };
  const state = async (): Promise<DaemonState | null> => {
    try { return JSON.parse(await readFile(cursor, 'utf8')); } catch { return null; }
  };
  const flight = (value: DaemonState | null, key: string) => value?.mergeWriter.inFlights?.find(entry => entry.key === key);
  const commandsPath = join(world.trials, 'commands.jsonl');
  const commands = async () => (await readFile(commandsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { step: string; key: string });
  const ledger = async (id: string) => (await world.work()).find(entry => entry.id === id)?.mergeLedger?.state;
  try {
    start();
    await waitFor(commands, rows => rows.some(row => row.key === first.key && row.step === 'tests'), 'the first trial reaches its tests');
    assert.ok(!(await commands()).some(row => row.key === second.key), 'the second head waits for the one slot');
    await writeFile(join(world.trials, `release-${first.key}`), '');
    await waitFor(() => ledger(first.id), value => value === 'reconciled', 'the first head lands: ' + errors);
    const landed = await waitFor(state, value => flight(value, second.key)?.step === 'tests', 'the second trial starts after the landing');
    const initial = flight(landed, second.key)!;
    const merged = Object.values(landed!.actions).find(entry => entry.kind === 'merge' && entry.work === first.key && entry.state === 'done' && entry.detail.startsWith('Merged'));
    assert.equal(initial.startedAt, merged?.at, 'the second trial starts in the cycle the first head lands');
    await waitFor(commands, rows => rows.some(row => row.key === second.key && row.step === 'tests'), 'the second trial reaches its tests');

    // The loop restarts onto the new release while the second trial runs.
    const previousAdoption = (await state())?.actions['merge-writer-trial-adoption']?.at;
    await stop();
    start();
    await waitFor(state, value => !!value?.actions['merge-writer-trial-adoption'] && value.actions['merge-writer-trial-adoption'].at !== previousAdoption
      && flight(value, second.key)?.step === 'tests', 'the restarted loop adopts the trial');
    await delay(1200);
    const adopted = flight(await state(), second.key)!;
    assert.equal(adopted.attempt, initial.attempt, errors);
    assert.equal(adopted.startedAt, initial.startedAt);
    assert.deepEqual(adopted.run, initial.run);

    await writeFile(join(world.trials, `release-${second.key}`), '');
    await waitFor(() => ledger(second.id), value => value === 'reconciled', 'the adopted trial reaches its verdict: ' + errors);
    assert.deepEqual((await commands()).filter(row => row.key === second.key).map(row => row.step), ['install', 'build', 'tests'], 'the second trial ran once');
    const events = await world.store.events(second.id);
    assert.equal(events.filter(event => event.kind === 'merge.trial').length, 1);
    assert.equal(events.filter(event => event.kind === 'merge.pushed').length, 1);
    assert.equal((await readdir(trialRunsDirectory(world.checkout))).length, 2, 'one run per head');
  } finally {
    await stop();
    for (const name of await readdir(trialRunsDirectory(world.checkout)).catch(() => []))
      await stopTrialRun({ directory: join(trialRunsDirectory(world.checkout), name) });
    await world.close();
  }
});
