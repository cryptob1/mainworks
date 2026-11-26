import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { masterConfigSchema } from '../src/master.js';
import { runMergeTrial, trialFailureReason } from '../src/merge-writer/executor.js';
import { trialMerge } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3921 AC-3: only the reproduce-on-base round skips unread declared preMerge checks.
// The item trial's first round and the batch gate's verified-commit probe still run and report them.

const homeCase = { id: 'home-served', title: 'The home page answers', target: 'any', required: false,
  steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'message', equals: 'served' }] }] };

const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [],
  run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });

async function fixture() {
  const { root, head: baseTip } = await gitRepo({ label: 'reproduce-round-only', files: {
    'package.json': JSON.stringify({ name: 'fixture' }),
    'graphyard.json': JSON.stringify({
      e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } },
      delivery: { mode: 'local', candidateSchedule: null, deploy: { adapter: 'command', uat: null, production: null }, mergeGate: { perCandidate: [], preMerge: [
        { check: 'lint', command: 'node checks/lint.mjs', source: 'script', reason: 'fixture' },
      ] } },
    }),
    'e2e/cases/home-served.json': JSON.stringify(homeCase),
  } });
  git(root, 'checkout', '-q', '-b', 'head');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  await writeFile(join(root, 'change.txt'), 'change\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'head');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  const merged = await trialMerge((args: readonly string[]) => defaultChildRun('git', ['-C', root, ...args]), { head, baseTip });
  assert.ok('mergeSha' in merged);
  return { root, baseTip, mergeSha: merged.mergeSha, base: await temporaryDirectory('reproduce-round-only-base') };
}

function instrumentedRun(fails: (check: string, nth: number) => boolean, e2eFails: (nth: number) => boolean = () => false) {
  const started: string[] = [];
  let e2eRuns = 0;
  const run: ChildRun = async (command, args, options) => {
    const check = command === 'node' && /^checks\/(\w+)\.mjs$/.exec(args[0] ?? '')?.[1];
    if (check) {
      started.push(check);
      if (fails(check, started.filter(name => name === check).length)) {
        throw Object.assign(new Error(`${check} failed`), { status: 1, signal: null, stdout: `${check} failed\n`, stderr: '' });
      }
      return '';
    }
    if (command === 'node' && args.at(-1)?.endsWith('/run.mjs') && options?.input) {
      e2eRuns++;
      const nonce = String(options.input).trim();
      const failed = e2eFails(e2eRuns) ? 1 : 0;
      return `\nmainworks-verdict:${nonce} ${JSON.stringify([{ proof: 'e2e:home-served', case: 'home-served', executed: 1, failed }])}\n`;
    }
    if (command === 'npm') return '';
    return defaultChildRun(command, args, options);
  };
  return { run, started };
}

test('integration:reproduce-round-only — first round and batch gate verified-commit probe report a failing declared check while reproduce-on-base skips it', { timeout: 120_000 }, async () => {
  const repo = await fixture();
  const environment = { PATH: process.env.PATH!, HOME: process.env.HOME! };

  // 1. Item trial first round: a failing declared preMerge check runs and refuses the candidate.
  const firstRound = instrumentedRun(check => check === 'lint');
  const candidate = await runMergeTrial({
    ...repo, changedFiles: ['change.txt'], proofs: [], proofFiles: [], e2eProofs: ['e2e:home-served'],
    reproduce: true, attribute: false, retries: 0, timeoutMs: 120_000, key: 'GY-3921', environment, run: firstRound.run,
  });
  assert.deepEqual(firstRound.started, ['lint'], 'first round starts the declared preMerge check');
  assert.match(trialFailureReason({ run: candidate }) ?? '', /lint/, 'first round reports the failing declared check');

  // 2. Batch gate verified-commit probe (commit === trusted()): still runs and reports the failing declared preMerge check.
  const gateProbe = instrumentedRun(check => check === 'lint');
  const reads = mergeWriterReads(config, repo.root, gateProbe.run, {
    base: await temporaryDirectory('reproduce-round-only-gate'),
    record: async () => {},
    environment,
  });
  const ports = batchGatePorts(reads as typeof reads & { git: NonNullable<typeof reads.git> }, [], () => repo.baseTip);
  const failed = await ports.run(repo.baseTip, ['test:lint'], [], 120_000);
  assert.deepEqual(gateProbe.started, ['lint'], 'the batch gate verified-commit probe starts the declared preMerge check');
  assert.deepEqual(failed, ['test:lint'], 'the batch gate verified-commit probe reports the failing declared check');

  // 3. Reproduce-on-base round: when round 1 passes, round 2 skips the unread declared preMerge check (even though it would fail on base).
  const reproRound = instrumentedRun((check, nth) => check === 'lint' && nth >= 2, nth => nth >= 2);
  const reproduced = await runMergeTrial({
    ...repo, changedFiles: ['change.txt'], proofs: [], proofFiles: [], e2eProofs: ['e2e:home-served'],
    reproduce: true, attribute: false, retries: 0, timeoutMs: 120_000, key: 'GY-3921', environment, run: reproRound.run,
  });
  assert.equal(trialFailureReason({ run: reproduced }), null, reproduced.logTail);
  assert.deepEqual(reproduced.passingOnBase, [], 'the reproduce-on-base round ran and reproduced the e2e proof on base');
  assert.deepEqual(reproRound.started, ['lint'], 'only round 1 starts lint; the reproduce-on-base round skips it');
});
