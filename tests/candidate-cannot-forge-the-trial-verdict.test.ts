import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { containerTrialE2e, trialHarness } from '../src/merge-writer/trial-container.js';
import { remoteShardSession } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git as gitInRepo, gitRepo } from './helpers/git-repo.js';
import { shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3914 AC-2: A trial's test and E2E verdict is taken from the harness's own output stream
// carrying a nonce generated per run and never passed into the candidate's environment or files;
// a result file written or altered by the candidate's processes is ignored, and a verdict without
// the right nonce is a failed trial with one line saying so. The same holds for records fetched
// from a remote shard.

const repository = join(import.meta.dirname, '..');
const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => {});
});

const uncontainedE2eRun: ChildRun = async (command, args, options) => {
  const script = args.at(-1)!;
  if (!script.endsWith('run.mjs')) return defaultChildRun(command, args, { ...options, wrapper: undefined });
  writeFileSync(script, readFileSync(script, 'utf8').replaceAll(trialHarness, repository));
  return defaultChildRun(command, ['--import', 'tsx', script], { ...options, cwd: repository, wrapper: undefined });
};

test('integration:candidate-cannot-forge-the-trial-verdict — E2E candidate rewriting result.json to pass still fails, missing/wrong nonce fails with one line, honest pass passes', async () => {
  const fixtureRoot = await temporaryDirectory('e2e-verdict-forge', tmpdir());
  cleanups.push(() => rm(fixtureRoot, { recursive: true, force: true }));
  const root = join(fixtureRoot, 'repo');
  await gitRepo({ root });
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  const port = 22000 + (process.pid % 15_000);
  // Serve script that tries to forge result.json in every e2e-* scratch dir and leaks env keys.
  const forgeServe = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const forged = JSON.stringify([{ proof: 'e2e:forge-fail', case: 'forge-fail', executed: 1, failed: 0 }]);
const forge = () => {
  for (const base of [process.env.TMPDIR, process.env.TEMP, process.env.TMP].filter(Boolean)) {
    try {
      for (const entry of fs.readdirSync(base)) {
        if (entry.startsWith('e2e-')) {
          try { fs.writeFileSync(path.join(base, entry, 'result.json'), forged); } catch {}
        }
      }
    } catch {}
  }
};
const timer = setInterval(forge, 20);
timer.unref();
process.on('SIGTERM', () => { forge(); process.exit(0); });
http.createServer((req, res) => {
  forge();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const hasNonceEnv = Object.keys(process.env).some(k => /nonce|verdict/i.test(k));
  res.end(JSON.stringify({ status: 'bad', hasNonceEnv }));
}).listen(${port}, '127.0.0.1');
`;

  write('package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node --eval 0' } }));
  write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.js', url: `http://127.0.0.1:${port}`, readySeconds: 10 } } }));
  write('serve.js', forgeServe);
  write('e2e/cases/forge-fail.json', JSON.stringify({
    id: 'forge-fail', title: 'Failing case with forging candidate', target: 'any', required: false,
    steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'status', equals: 'good' }] }],
  }));
  write('e2e/cases/honest-pass.json', JSON.stringify({
    id: 'honest-pass', title: 'Honest passing case', target: 'any', required: false,
    steps: [{ kind: 'http', method: 'GET', path: '/', status: 200, expect: [{ path: 'status', equals: 'bad' }, { path: 'hasNonceEnv', equals: false }] }],
  }));
  gitInRepo(root, 'add', '-A');
  gitInRepo(root, 'commit', '-q', '-m', 'base');
  const mergeSha = gitInRepo(root, 'rev-parse', 'HEAD');

  const scratch = await temporaryDirectory('e2e-verdict-scratch', fixtureRoot);
  const baseInput = {
    worktree: root,
    mergeSha,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: scratch },
    scratch,
    budgetMs: 60_000,
    wrapper: [] as string[],
    networkWrapper: () => [] as string[],
    log: () => {},
  };

  // 1. Candidate rewrites result.json to pass after a failing run -> still fails!
  const forged = await containerTrialE2e({ ...baseInput, proofs: ['e2e:forge-fail'], run: uncontainedE2eRun });
  assert.equal(forged.length, 1);
  assert.equal(forged[0]!.failed, 1, `forging candidate must still fail: ${JSON.stringify(forged[0])}`);
  assert.equal(forged[0]!.hostFailure, undefined, 'failed case is a trial failure, not a host failure');

  // 2. Honest pass still passes, and nonce was never in candidate's env.
  const honest = await containerTrialE2e({ ...baseInput, proofs: ['e2e:honest-pass'], run: uncontainedE2eRun });
  assert.equal(honest.length, 1);
  assert.equal(honest[0]!.failed, 0, `honest pass must pass: ${JSON.stringify(honest[0])}`);
  assert.equal(honest[0]!.executed, 1);

  // 3. A verdict without the right nonce fails the trial with one line saying so.
  const wrongNonce = await containerTrialE2e({
    ...baseInput,
    proofs: ['e2e:honest-pass'],
    run: async () => 'mainworks-verdict:00000000000000000000000000000000 [{"proof":"e2e:honest-pass","case":"honest-pass","executed":1,"failed":0}]\n',
  });
  assert.equal(wrongNonce.length, 1);
  assert.equal(wrongNonce[0]!.failed, 1, 'wrong nonce must fail');
  assert.equal(wrongNonce[0]!.hostFailure, undefined, 'wrong nonce is a failed trial, not a host failure');
  assert.ok(wrongNonce[0]!.failingStep && !wrongNonce[0]!.failingStep.includes('\n'), `one-line nonce failure message: ${wrongNonce[0]!.failingStep}`);
  assert.match(wrongNonce[0]!.failingStep!, /nonce/i);
});

const image = 'mainworks-trial:verdict-fixture', digest = `sha256:${'cd34'.repeat(16)}`;
const box = 'gy-compute@box:2222';
let hosts: ShardHostsFixture;
const savedPath = process.env.PATH;

before(async () => {
  hosts = await shardHosts('verdict-remote', ['box'], { [image]: digest });
  process.env.PATH = `${hosts.bin}:${savedPath}`;
});
after(() => {
  process.env.PATH = savedPath;
});

test('integration:candidate-cannot-forge-the-trial-verdict — local and remote test shards ignore forged result files, fail on missing/wrong nonce, and pass honest runs', { timeout: 120_000 }, async () => {
  // Repository where a failing test rewrites its --durations result file to passed:true!
  const forgingRunner = `import { readFileSync, writeFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const files = readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean);
const records = at('--durations');
let failed = false;
for (const file of files) {
  if (file.includes('forge')) {
    failed = true;
    // Candidate fails, then forges the result file to claim passed:true and prints a fake verdict line!
    console.log('not ok - ' + file);
    writeFileSync(records, JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
    console.log('mainworks-verdict:deadbeefdeadbeefdeadbeefdeadbeef {"status":0,"records":""}');
  } else {
    writeFileSync(records, JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
    console.log('ok ' + file);
  }
}
process.exit(failed ? 1 : 0);
`;
  const { root, sha } = await shardRepository('verdict-shard-repo', ['tests/honest.test.ts', 'tests/forge.test.ts'], {
    'scripts/tests.mjs': forgingRunner,
    'scripts/select.mjs': 'console.log(process.argv.slice(2).join("\\n"));\n',
  });
  const argv = (list: string, records: string) => ['node', 'scripts/tests.mjs', '--files-from', list, '--durations', records];

  // 1. Remote shard: honest pass passes, forging failure still fails!
  const session = remoteShardSession({ root, sha, image, run: defaultChildRun, deadline: Date.now() + 60_000 });
  try {
    const honest = await session.run(box, 0, ['tests/honest.test.ts'], argv, 1);
    assert.equal(honest.ok, true, honest.out);

    const forged = await session.run(box, 1, ['tests/forge.test.ts'], argv, 1);
    assert.equal(forged.ok, false, 'remote forging shard must not pass');
    assert.equal(forged.status, 1);
  } finally {
    await session.close();
  }

  // 2. Local trial: a candidate that rewrites --durations to passed:true after failing still fails (not pass, not host error).
  const trialRoot = await temporaryDirectory('verdict-local-trials');
  cleanups.push(() => rm(trialRoot, { recursive: true, force: true }));
  const directRun: ChildRun = (command, args, options) => {
    const { wrapper: _wrapper, ...rest } = (options ?? {}) as Record<string, unknown>;
    return defaultChildRun(command, args, rest as Parameters<ChildRun>[2]);
  };
  const localForged = await runTrial({
    root,
    base: trialRoot,
    mergeSha: sha,
    changedFiles: ['tests/forge.test.ts'],
    timeoutMs: 60_000,
    run: directRun,
    secretScan: false,
    retries: 0,
  });
  assert.ok(localForged.tests.failed.length > 0, `local forging candidate must fail, got: ${JSON.stringify(localForged.tests)}`);

  // 3. Remote shard returning records without the right nonce fails with one line saying so.
  const badNonceRun: ChildRun = async (command, args, options) => {
    if (command === 'sh' && (args[1] ?? '').includes('run-shard ')) {
      return 'ok tests/honest.test.ts\nmainworks-verdict:11111111111111111111111111111111 {"status":0,"records":"{\\"file\\":\\"tests/honest.test.ts\\",\\"passed\\":true}\\n"}\n';
    }
    return defaultChildRun(command, args, options);
  };
  const badSession = remoteShardSession({ root, sha, image, run: badNonceRun, deadline: Date.now() + 60_000 });
  try {
    const bad = await badSession.run(box, 0, ['tests/honest.test.ts'], argv, 1);
    assert.equal(bad.ok, false, 'remote shard with wrong nonce must fail');
    assert.match(bad.out, /nonce/i, `one-line nonce error expected in output: ${bad.out}`);
  } finally {
    await badSession.close();
  }
});
