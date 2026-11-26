import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { serialReads } from '../benchmarks/hard-math/snapshot.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importTrialScript } from '../benchmarks/hard-math/fixture.js';
import { generateTrialVerdictNonce, parseTrialVerdict, trialHarness } from '../src/merge-writer/trial-container.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3422: the batch gate's check test:tests/hard-math-repair.test.ts failed once and passed its
// re-run. The runner's budget watchdog snapshots every 250 ms, and a snapshot taken while one was
// in flight joined it, so the fixture's snapshot after its last merge could return the item
// without that merge and fail `every(w=>w.merge)`.
test('unit:hard-math-repair-pinned — a snapshot requested while another is in flight observes writes made before the request', async () => {
  let merged = false;
  const read = serialReads(async () => { const seen = merged; await delay(20); return seen; });
  const watchdog = read();
  await delay(5);
  merged = true;
  assert.equal(await read(), true, 'the caller sees its own merge, not the in-flight read begun before it');
  assert.equal(await watchdog, false);
});

// GY-3920: the e2e trial script reads its run nonce from stdin (GY-3914). The fixture imports it in
// the test process, whose stdin never closes, so every hard-math repair run blocked on its first merge.
test('unit:hard-math-repair-pinned — an in-process e2e trial script takes its nonce from the trial input and returns its verdict', async () => {
  const directory = await temporaryDirectory('hard-math-trial-script');
  const script = join(directory, 'run.mjs'), nonce = generateTrialVerdictNonce();
  await writeFile(script, `
import { readFileSync } from 'node:fs';
import { runTrialE2eGroup } from '${trialHarness}/src/merge-writer/e2e-trial.ts';
const nonce = readFileSync(0, 'utf8').trim();
const cases = await runTrialE2eGroup({"id":"serve","kind":"command","command":"true","url":"http://127.0.0.1:1/","readySeconds":1}, [], { worktree: ${JSON.stringify(directory)}, mergeSha: 'f'.repeat(40), env: {}, scratch: ${JSON.stringify(directory)}, budgetMs: 1000, proofs: [], holds: async () => true, log: () => {} }, 'http://127.0.0.1:1');
process.stdout.write('\\n' + "mainworks-verdict:" + nonce + ' ' + JSON.stringify(cases) + '\\n');
`);
  const output = await importTrialScript(script, `${nonce}\n`, process.cwd());
  assert.deepEqual(parseTrialVerdict(output, nonce), { ok: true, value: [], stripped: '\n' });
});
