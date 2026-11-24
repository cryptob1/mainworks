import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { trialAdmission } from '../src/merge-writer/trial-load.js';

// GY-3784: tests/batch-gate-own-time.test.ts had three timing races under load:
// 1. trialAdmission printed the waiting line to stderr before writing its wait-<order>-<pid> marker,
//    so observing 'waiting' on stderr could precede trialStartWaiting('gate', slots) returning true.
// 2. After 'starting' and wait-marker removal, the test read (await creates())[1] immediately without
//    waiting for the forked guardian to run `docker create`, yielding undefined under load.
// 3. The wait-sampling test used a blind 1300 ms sleep racing runGate's 1000 ms interval instead of
//    waiting for the gate's own wait-sampling checkpoint.
test('unit:batch-gate-own-time-pinned — waiting marker precedes stderr announcement, gate create is awaited, and wait sampling uses checkpoint synchronization', async () => {
  const writeMarkerAt = trialAdmission.indexOf("with open(waiting, 'w')");
  const printWaitingAt = trialAdmission.indexOf("print('mainworks trial container: waiting: ' + why");
  assert.ok(writeMarkerAt > 0, 'trialAdmission writes the waiting marker file');
  assert.ok(printWaitingAt > 0, 'trialAdmission prints the waiting line to stderr');
  assert.ok(writeMarkerAt < printWaitingAt, 'the waiting marker file must be written before stderr announces waiting');

  const source = await readFile(new URL('./batch-gate-own-time.test.ts', import.meta.url), 'utf8');
  const waitForGateCreate = source.indexOf('(await creates()).length === 2');
  const readGateCreate = source.indexOf('(await creates())[1]');
  assert.ok(waitForGateCreate > 0 && readGateCreate > waitForGateCreate, 'must wait for the gate container create before reading creates()[1]');
  assert.doesNotMatch(source, /setTimeout\(resolve,\s*1300\)/, 'must synchronize on the wait-sampling checkpoint instead of a blind 1300 ms sleep');
});
