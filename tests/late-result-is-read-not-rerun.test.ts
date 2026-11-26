import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterExit } from '../src/merge-writer/trial-run.js';

// GY-3881 AC-3: a detached trial run writes its result just before it exits. A watcher whose
// outcome read came back empty and whose exit read then found the exit reads the outcome again,
// so the result that appeared between the two reads is accepted with that result, not failed as a
// run that reached no verdict (which would send it to be rerun).

test('unit:late-result-is-read-not-rerun — a result written between the outcome read and the exit read is the verdict', async () => {
  const verdict = { ok: true, run: { build: 'pass' } };
  let written = false, reads = 0;
  const outcome = async () => { reads++; return written ? verdict : null; };
  // The watcher's own outcome read: nothing yet. The run then writes its result and exits.
  assert.equal(await outcome(), null);
  written = true;
  assert.deepEqual(await afterExit(outcome, () => '0'), verdict);
  assert.equal(reads, 2, 'the outcome was read again after the exit');
});

test('unit:late-result-is-read-not-rerun — a run that exited with no result is still a run with no verdict, and a running one is not ended', async () => {
  assert.deepEqual(await afterExit(async () => null, () => '1'), { exit: '1' });
  assert.deepEqual(await afterExit(async () => null, () => null, () => true), { exit: null });
  assert.equal(await afterExit(async () => ({ ok: true }), () => null), null);
});
