import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, type MergePorts } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3982: GY-3957's fix added its regression case to an existing test file. The trial's base-tip run ran the
// base's own copy of that file, whose older cases pass, and refused the head as "the proof already passes
// before the change". The base-tip run now runs the candidate's copy of its proof files.

const proof = 'integration:trial-rework-cause-fixed-2';
const identity = { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { mergeWriter: { deployKeyFile: '/keys/deploy' } } });
const policy = { mode: 'local', mergeGate: { preMerge: [{ check: 'test', command: 'npm run test', source: 'script', reason: 'fixture' }], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command', project: null, uat: null, production: null } };

// The test check runs each `needs PATH` line of tests/fix.test.ts as one case of the proof, passing when PATH exists.
const runner = `const { existsSync, readFileSync } = require('node:fs');
const needs = [...readFileSync('tests/fix.test.ts', 'utf8').matchAll(/needs (\\S+)/g)].map(match => match[1]);
needs.forEach((path, index) => console.log((existsSync(path) ? 'ok ' : 'not ok ') + (index + 1) + ' - ${proof} ' + path));
process.exit(needs.every(path => existsSync(path)) ? 0 : 1);
`;

const run: ChildRun = async (command, args, options) => {
  options = { ...options, wrapper: undefined };
  if (command === 'git') return defaultChildRun(command, args, { ...options, env: { ...process.env, ...identity, ...options?.env } });
  if (command !== 'npm') return defaultChildRun(command, args, options);
  if (args[0] === 'run' && args[1] === 'test') {
    try { return await defaultChildRun('node', ['test.js'], options); }
    catch (error) { throw Object.assign(new Error('Command failed: npm run test'), { status: 1, signal: null, stdout: (error as { stdout?: string }).stdout ?? '', stderr: '' }); }
  }
  return '';
};

test(`${proof} — a bug fix that adds its failing-on-base case to an existing proof file merges instead of being refused as already passing on the base`, { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('trial-rework-cause-2', tmpdir());
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  write('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'true', test: 'node test.js' } }));
  write('graphyard.json', JSON.stringify({ delivery: policy }));
  write('test.js', runner);
  write('tests/fix.test.ts', `// ${proof}: an older case needs package.json\n`);
  const { head: base } = await gitRepo({ root, files: {} });
  git(root, 'checkout', '-q', '--detach');
  write('src/fixed', '');
  write('tests/fix.test.ts', `// ${proof}: an older case needs package.json\n// ${proof}: the regression case needs src/fixed\n`);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'fix and its regression case');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');

  const reads = mergeWriterReads(config, root, run, { base: await temporaryDirectory('trial-rework-cause-2-trials', tmpdir()), record: async () => {}, environment: { PATH: process.env.PATH! } });
  const ports: MergePorts = { baseBranch: 'main', now: () => Date.parse('2030-01-01T00:00:00Z'), fetch: async () => base, merge: reads.merge, trial: reads.trial,
    push: async () => 'pushed', holds: async () => false, record: async () => {} };
  const work = { id: 'w-3982', key: 'GY-3982', type: 'bug', title: 'fix', candidate: { sha: head, baseSha: base, pr: 1, branch: 'graphyard/gy-3982-1', author: 'worker' },
    submission: { epoch: 1, pr: 1 }, criteria: [{ id: 'AC-1', text: 'the bug is fixed', proofs: [proof] }] } as unknown as Work;
  const outcome = await mergeOne(ports, work);
  assert.equal(outcome.outcome, 'merged', JSON.stringify(outcome));
});
