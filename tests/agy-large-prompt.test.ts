import { after, before } from 'node:test';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';
import { gitRepo } from './helpers/git-repo.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { liveRun } from '../src/runner/registry.js';
import { spawnHeadless, startHeadlessSession } from '../src/headless-session.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { listen } from './helpers/http-server.js';
import { until } from './helpers/until.js';

// GY-3696: Headless agy sessions take a large prompt without spawn E2BIG.
// Linux MAX_ARG_STRLEN is 128 KiB (131,072 bytes) per argv element; a prompt larger than that
// fails spawn with E2BIG when passed on the command line.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const reviewer = 'review-agy-1';
const now = () => new Date().toISOString();

let store: Store, close: (() => Promise<void>) | undefined, url: string;
let scratch: string, root: string, bin: string, credentials: string, agyHome: string, base: string, head: string;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

before(async () => {
  store = await withDatabase('agy-large-prompt'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));

  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('agy-large-prompt', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch);
  credentials = await temporaryDirectory('credentials', scratch);
  agyHome = await temporaryDirectory('agy-home', scratch);

  // A stub agy executable matching real agy's CLI contract:
  // - With -p / --print / --prompt, requires a non-empty prompt value as the next arg (never reads stdin).
  // - Without a print flag, reads the full prompt from stdin (non-TTY print mode).
  // Records every launch's argv, delivery source and exact prompt hash/length/markers.
  await writeFile(join(bin, 'agy'), `#!${process.execPath}
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const recordFile = process.env.AGY_RECORD_FILE;
const printIndex = args.findIndex(arg => arg === '-p' || arg === '--print' || arg === '--prompt');
let prompt = '', source = 'stdin';
if (printIndex >= 0) {
  if (printIndex + 1 >= args.length) { console.error('flag needs an argument: ' + args[printIndex]); process.exit(2); }
  prompt = args[printIndex + 1];
  if (!prompt) { console.error('error: Error: empty prompt. Usage: agy --print "your prompt here"'); process.exit(1); }
  source = 'argv';
} else {
  prompt = fs.readFileSync(0, 'utf8');
  if (!prompt) { console.error('error: Error: empty prompt on stdin'); process.exit(1); }
}
const hash = createHash('sha256').update(prompt, 'utf8').digest('hex');
if (recordFile) {
  fs.writeFileSync(recordFile, JSON.stringify({ args, source, length: Buffer.byteLength(prompt, 'utf8'), hash, head: prompt.slice(0, 120), tail: prompt.slice(-120), hasDiff: prompt.includes('agy-large-diff-marker') }));
}
if (process.env.AGY_REVIEW_HEAD && process.env.AGY_REVIEW_BASE) {
  console.log(JSON.stringify({ verdict: 'APPROVE', body: 'Reviewed head ' + process.env.AGY_REVIEW_HEAD + ' against base ' + process.env.AGY_REVIEW_BASE + '. AC-1 met: large diff reviewed on agy.', findings: [] }));
} else {
  console.log(JSON.stringify({ ok: true, source, length: Buffer.byteLength(prompt, 'utf8'), hash }));
}
`, { mode: 0o755 });

  // A git repository with a very large diff (> 150 KiB across a rename sweep).
  const lines = Array.from({ length: 2400 }, (_, i) => `export const graphyardSymbol_${i} = "graphyard-value-${i}-${'a'.repeat(40)}";`).join('\n') + '\n';
  const repo = await gitRepo({ root, files: { 'README.md': 'Named spec file.\n', 'sweep.ts': lines } }), git = repo.git;
  base = repo.head;
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'a-marker.ts'), 'export const marker = "agy-large-diff-marker";\n');
  const renamed = lines.replaceAll('graphyard', 'mainworks');
  await writeFile(join(root, 'sweep.ts'), renamed);
  git('add', 'a-marker.ts', 'sweep.ts'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'rename sweep');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);

  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', {
    runtimes: [{ name: 'agy', launch: { kind: 'agy', args: ['--dangerously-skip-permissions'], headlessArgs: ['--dangerously-skip-permissions', '--print', '{request}'],
      environment: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: agyHome }, homeVariable: 'AGY_CONFIG_DIR', modelFlag: '--model' } }],
    models: [{ name: 'agy-default', id: 'Gemini 4 Neon (Medium)' }],
    accounts: [{ name: 'reviewer-agy', runtime: 'agy', model: 'agy-default', credential: { host: config.hostId, home: agyHome } }],
    roles: [{ name: 'reviewer', accounts: ['reviewer-agy'], concurrency: 4 }],
    reason: 'agy large prompt test registry',
  }, randomUUID());
  await new AgentRegistry(store).observe(coordinator, { host: config.hostId, observations: [{ account: 'reviewer-agy', quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } }] }, randomUUID());
  await saveReviewerProfile(root, { name: 'reviewer-agy', agentName: reviewer, kind: 'agy', agentArgs: [] });
});

after(async () => { await close?.(); if (store) await store.close(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };

test('integration:agy-large-prompt — a headless agy session with a prompt over the platform argument limit starts and receives the whole prompt while small prompts behave as today', async () => {
  const largeRecord = join(scratch, 'large-record.json');
  const smallRecord = join(scratch, 'small-record.json');
  const contract = { args: ['--dangerously-skip-permissions'], headlessArgs: ['--dangerously-skip-permissions', '--print', '{request}'] };
  const baseEnv = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: agyHome };

  // > 200 KiB: well above Linux's 128 KiB (131,072 byte) MAX_ARG_STRLEN single-argument limit.
  const largePrompt = `LARGE_PROMPT_START\n${'rename-sweep-line-0123456789abcdef\n'.repeat(6000)}LARGE_PROMPT_END`;
  assert.ok(Buffer.byteLength(largePrompt, 'utf8') > 131_072, 'prompt exceeds Linux MAX_ARG_STRLEN');

  const large = await startHeadlessSession({
    name: 'agy-large-1', work: 'GY-3696', subject: 'large prompt',
    kind: 'agy', args: ['--model', 'Gemini 4 Neon (Medium)'],
    environment: { ...baseEnv, AGY_RECORD_FILE: largeRecord },
    directory: root, contract, prompt: largePrompt,
    answer: async output => JSON.parse(output) as { ok: boolean; source: string; length: number; hash: string },
    root, route: 'review', context: {}, exec: spawnHeadless,
  });
  const largeResult = await large.settled;
  assert.equal(largeResult.ok, true);
  assert.equal(largeResult.source, 'stdin', 'large prompt is delivered on stdin rather than argv');
  const largeSeen = JSON.parse(await readFile(largeRecord, 'utf8'));
  assert.ok(largeSeen.args.includes('--dangerously-skip-permissions'), 'other launch arguments are preserved');
  assert.ok(largeSeen.args.includes('--model') && largeSeen.args.includes('Gemini 4 Neon (Medium)'), 'model flag is preserved');
  assert.ok(!largeSeen.args.includes('--print'), '--print flag is omitted when prompt goes on stdin');
  assert.ok(largeSeen.length >= Buffer.byteLength(largePrompt, 'utf8'), 'whole prompt including autonomy contract is received');
  assert.ok(largeSeen.tail.includes('LARGE_PROMPT_END'), 'prompt tail is intact');
  assert.equal(largeResult.hash, largeSeen.hash);

  // Small prompt: behaves exactly as today (passed via --print <prompt> on argv).
  const smallPrompt = 'Small agy prompt check';
  const small = await startHeadlessSession({
    name: 'agy-small-1', work: 'GY-3696', subject: 'small prompt',
    kind: 'agy', args: ['--model', 'Gemini 4 Neon (Medium)'],
    environment: { ...baseEnv, AGY_RECORD_FILE: smallRecord },
    directory: root, contract, prompt: smallPrompt,
    answer: async output => JSON.parse(output) as { ok: boolean; source: string; length: number; hash: string },
    root, route: 'review', context: {}, exec: spawnHeadless,
  });
  const smallResult = await small.settled;
  assert.equal(smallResult.ok, true);
  assert.equal(smallResult.source, 'argv', 'small prompt still passes on argv as today');
  const smallSeen = JSON.parse(await readFile(smallRecord, 'utf8'));
  const printAt = smallSeen.args.indexOf('--print');
  assert.ok(printAt >= 0, '--print stays in argv for small prompts');
  assert.ok(smallSeen.args[printAt + 1].includes(smallPrompt), 'small prompt text is in argv');
  assert.equal(smallResult.hash, sha256(smallSeen.args[printAt + 1]));
});

test('e2e:agy-large-prompt — a review of a change with a very large diff run on agy posts a verdict', async () => {
  const reviewRecord = join(scratch, 'review-record.json');
  const candidate = { sha: head, baseSha: base, pr: 94, branch: 'graphyard/gy-3594-1', author: 'graphyard-claude-1' };
  // Large criterion + 80 KiB diff excerpt pushes the assembled review prompt well past Linux MAX_ARG_STRLEN (131,072 bytes).
  const bigCriteria = [{
    id: 'AC-1',
    text: `Rename sweep criterion: ${'every reference in module group updated cleanly without regression; '.repeat(1100)}`,
    proofs: ['unit:works'],
  }];
  const work = await insert(workFixture({ id: randomUUID(), key: 'GY-9696', title: 'Large rename sweep', priority: 1, criteria: bigCriteria, systemDriven: undefined,
    stage: 'review', revision: 3, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), epoch: 1, candidate, submission: { epoch: 1, pr: 94 }, gates: [], implementers: ['graphyard-claude-1'],
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }],
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['sweep.ts'], scopeFiles: [{ path: 'sweep.ts', status: 'modified', sha: head, additions: 2401, deletions: 2400, binary: false }], baseTip: base, baseTipContained: true } as never }));

  // Inject record/head/base env into the agy runtime for the review launch.
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', {
    runtimes: [{ name: 'agy', launch: { kind: 'agy', args: ['--dangerously-skip-permissions'], headlessArgs: ['--dangerously-skip-permissions', '--print', '{request}'],
      environment: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: agyHome, AGY_RECORD_FILE: reviewRecord, AGY_REVIEW_HEAD: head, AGY_REVIEW_BASE: base },
      homeVariable: 'AGY_CONFIG_DIR', modelFlag: '--model' } }],
    models: [{ name: 'agy-default', id: 'Gemini 4 Neon (Medium)' }],
    accounts: [{ name: 'reviewer-agy', runtime: 'agy', model: 'agy-default', credential: { host: config.hostId, home: agyHome } }],
    roles: [{ name: 'reviewer', accounts: ['reviewer-agy'], concurrency: 4 }],
    reason: 'agy review e2e env',
  }, randomUUID());
  await new AgentRegistry(store).observe(coordinator, { host: config.hostId, observations: [{ account: 'reviewer-agy', quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } }] }, randomUUID());

  const run = (command: string, args: string[], options?: { cwd?: string }) => {
    if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
    throw new Error(`no ${command} here: a headless launch opens no pane`);
  };
  const launched = await launchReview(root, work, 'reviewer-agy', [], now(), { run, headless: spawnHeadless, requestId: 'agy-large-diff-review' });
  await until(async () => (await readReviewLedger(root)).reviews.some(record => record.id === launched.review && !liveRun(record.agentName) && (record.verdict || record.state !== 'pending')), 'the agy review to settle', 10_000, 25);
  const record = (await readReviewLedger(root)).reviews.find(entry => entry.id === launched.review)!;
  assert.equal(record.verdict?.state, 'APPROVED', record.resolution);
  assert.equal(record.verdict?.reviewer, reviewer);

  const seen = JSON.parse(await readFile(reviewRecord, 'utf8'));
  assert.ok(seen.length > 131_072, `expected review prompt > 131072 bytes, got ${seen.length}`);
  assert.equal(seen.source, 'stdin');
  assert.equal(seen.hasDiff, true, 'review prompt carried the diff');

  const reviewed = await stored(work.id);
  const [review] = reviewed.observation!.reviews as { reviewer: string; sha: string; state: string; source?: string }[];
  assert.deepEqual([review!.reviewer, review!.sha, review!.state, review!.source], [reviewer, head, 'APPROVED', 'control-plane']);
});
