import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runMergeTrial, trialFailureReason } from '../src/merge-writer/executor.js';
import { trialMerge } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3921: the reproduce-on-base round proves the item's own proofs fail on the base tip. A declared
// preMerge check none of them names is started in the first round only; a check: proof's check runs in both.

const homeCase = { id: 'home-served', title: 'The home page answers', target: 'any', required: false,
  steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'served' }] }] };

async function fixture(extra: { check: string; command: string; source: string; reason: string }[] = []) {
  const { root, head: baseTip } = await gitRepo({ label: 'reproduce-checks', files: {
    'package.json': JSON.stringify({ name: 'fixture' }),
    'graphyard.json': JSON.stringify({
      e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } },
      delivery: { mode: 'local', candidateSchedule: null, deploy: { adapter: 'command', uat: null, production: null }, mergeGate: { perCandidate: [], preMerge: [
        { check: 'lint', command: 'node checks/lint.mjs', source: 'script', reason: 'fixture' },
        { check: 'parity', command: 'node checks/parity.mjs', source: 'script', reason: 'fixture' }, ...extra,
      ] } },
    }),
    'tests/fix.test.ts': '// unit:fix\n',
  } });
  git(root, 'checkout', '-q', '-b', 'head');
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  await writeFile(join(root, 'e2e/cases/home-served.json'), JSON.stringify(homeCase));
  await writeFile(join(root, 'change.txt'), 'change\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'head');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  const merged = await trialMerge((args: readonly string[]) => defaultChildRun('git', ['-C', root, ...args]), { head, baseTip });
  assert.ok('mergeSha' in merged);
  return { root, baseTip, mergeSha: merged.mergeSha, base: await temporaryDirectory('reproduce-checks-base') };
}

/** Runs the trial, recording each declared check's starts; `fails(check, nth)` says whether its nth start fails. The E2E runner answers that its case passed. */
async function trial(item: { e2eProofs?: string[]; checkProofs?: string[]; proofs?: string[]; proofFiles?: string[] }, fails: (check: string, nth: number) => boolean = () => false, extra: Parameters<typeof fixture>[0] = []) {
  const repo = await fixture(extra), started: string[] = [];
  const run: ChildRun = async (command, args, options) => {
    const check = command === 'node' && /^checks\/(\w+)\.mjs$/.exec(args[0] ?? '')?.[1];
    if (check) {
      started.push(check);
      if (fails(check, started.filter(name => name === check).length)) throw Object.assign(new Error(`${check} failed`), { status: 1, signal: null, stdout: `${check} failed\n`, stderr: '' });
      return '';
    }
    if (command === 'node' && args.at(-1)?.endsWith('/run.mjs') && options?.input) {
      const nonce = String(options.input).trim();
      return `\nmainworks-verdict:${nonce} ${JSON.stringify([{ proof: 'e2e:home-served', case: 'home-served', executed: 1, failed: 0 }])}\n`;
    }
    if (command === 'npm') return '';
    return defaultChildRun(command, args, options);
  };
  const result = await runMergeTrial({ ...repo, changedFiles: ['change.txt', 'e2e/cases/home-served.json'], proofs: [], proofFiles: [], ...item,
    reproduce: true, attribute: false, retries: 0, timeoutMs: 120_000, key: 'GY-3921', environment: { PATH: process.env.PATH!, HOME: process.env.HOME! }, run });
  return { result, started };
}

test('unit:reproduce-on-base-skips-unread-declared-checks — an e2e-proof item: round 1 runs both declared checks, round 2 starts none', async () => {
  const { result, started } = await trial({ e2eProofs: ['e2e:home-served'] });
  assert.equal(trialFailureReason({ run: result }), null, result.logTail);
  assert.ok(result.passingOnBase || result.notReproduced, 'the reproduce-on-base round ran');
  assert.deepEqual(started, ['lint', 'parity']);
});

test('unit:reproduce-on-base-skips-unread-declared-checks — a check-proof item: round 2 starts only that check', async () => {
  // parity fails on the base tip, so the change is reproduced; lint, which no proof names, is never started there.
  const { result, started } = await trial({ checkProofs: ['check:parity'] }, (check, nth) => check === 'parity' && nth === 2);
  assert.equal(trialFailureReason({ run: result }), null, result.logTail);
  assert.deepEqual(result.proofs['check:parity'], { executed: 1, failed: 0 });
  assert.deepEqual(result.passingOnBase, []);
  assert.deepEqual(started, ['lint', 'parity', 'parity']);
});

test('unit:reproduce-on-base-skips-unread-declared-checks — a failing declared check in round 1 still refuses the merge', async () => {
  const { result, started } = await trial({ e2eProofs: ['e2e:home-served'] }, check => check === 'lint');
  assert.match(trialFailureReason({ run: result }) ?? '', /lint/);
  assert.equal(result.notReproduced, undefined);
  assert.deepEqual(started, ['lint']);
});

test('unit:reproduce-on-base-skips-unread-declared-checks — a unit-proof item: round 2 starts only the test runner its proof files run through', async () => {
  const { result, started } = await trial({ proofs: ['unit:fix'], proofFiles: ['tests/fix.test.ts'] }, () => false, [{ check: 'test', command: 'node checks/test.mjs', source: 'script', reason: 'fixture' }]);
  assert.equal(result.build, 'pass', result.logTail);
  assert.deepEqual(started, ['lint', 'parity', 'test', 'test']);
});
