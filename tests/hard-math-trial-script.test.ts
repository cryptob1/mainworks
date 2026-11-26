import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importTrialScript } from '../benchmarks/hard-math/fixture.js';
import { generateTrialVerdictNonce, parseTrialVerdict, trialHarness } from '../src/merge-writer/trial-container.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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
