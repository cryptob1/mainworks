import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { caseDirectory, loadCases } from '../src/e2e/case.js';
import { runCases } from '../src/e2e/runner.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3641: a compare step whose baseline leg cannot be driven is not comparable; the candidate's
// own leg decides pass or fail, and the baseline's failure never asks the candidate for rework.

/** A fake agent-browser: the baseline session cannot open its page; the candidate answers the reply file. */
async function fakeAgentBrowser(dir: string, candidateReply: string) {
  const bin = join(dir, 'bin'); await mkdir(bin, { recursive: true });
  const reply = join(dir, 'reply.txt');
  await writeFile(reply, candidateReply);
  await writeFile(join(bin, 'agent-browser'), `#!/bin/sh\ncase "$2" in *-baseline) [ "$3" = open ] && { echo 'net::ERR_CONNECTION_REFUSED'; exit 1; };; esac\ncase "$3" in\n  chat) cat ${JSON.stringify(reply)}; exit 0 ;;\n  screenshot) printf 'png' > "$4" ;;\nesac\n`);
  await chmod(join(bin, 'agent-browser'), 0o755);
  return bin;
}

async function run(candidateReply: string, runId: string) {
  const scratch = await temporaryDirectory(`broken-baseline-${runId}`);
  const bin = await fakeAgentBrowser(scratch, candidateReply);
  const root = await temporaryDirectory('broken-baseline-repo', scratch);
  await mkdir(join(root, caseDirectory), { recursive: true });
  await writeFile(join(root, caseDirectory, 'compare.json'), JSON.stringify({ id: 'compare', title: 'Compare', target: 'any', steps: [{ kind: 'agent', goal: 'Open the editor', success: ['The editor shows'], path: '/editor', compare: true }] }));
  const report = await runCases(await loadCases(root), { url: 'http://candidate.test', baselineUrl: 'http://baseline.test', token: 'token', root, runId, artifactsDirectory: join(root, 'shots'),
    hostEnvironment: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME }, judge: async () => { throw new Error('nothing is judged without a baseline run'); } });
  return report.cases[0]!;
}

test('unit:broken-baseline-is-not-the-candidates-fault — a baseline that cannot be driven makes the step not comparable with its error; the candidate\'s own leg decides', async () => {
  // Baseline failing, candidate passing: the step passes, recorded not comparable with the baseline's error.
  const passing = await run('VERDICT: PASS\n', 'bb1');
  assert.equal(passing.outcome, 'pass', JSON.stringify(passing.failingStep));
  assert.equal(passing.failingStep, null, 'no failure, so no rework is requested for the baseline');
  const step = passing.attemptResults[0]!.steps![0]!;
  assert.equal(step.outcome, 'pass');
  assert.match(step.comparison ?? '', /^not comparable: .*could not open http:\/\/baseline\.test\/editor.*ERR_CONNECTION_REFUSED/);

  // Both failing: the step fails on the candidate's own reason, never the baseline's, and is still not comparable.
  const failing = await run('VERDICT: FAIL - the editor never loads\n', 'bb2');
  assert.equal(failing.outcome, 'fail');
  assert.equal(failing.failingStep!.reason, 'the editor never loads');
  assert.match(failing.attemptResults[0]!.steps![0]!.comparison ?? '', /^not comparable: .*baseline\.test/);
});
