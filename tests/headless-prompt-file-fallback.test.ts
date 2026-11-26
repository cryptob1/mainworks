import { after, before } from 'node:test';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { loadMasterConfig, setupMaster } from '../src/master.js';
import { launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { liveRun } from '../src/runner/registry.js';
import { spawnHeadless, startHeadlessSession } from '../src/headless-session.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { listen } from './helpers/http-server.js';
import { workFixture } from './helpers/work-fixture.js';
import { until } from './helpers/until.js';

// GY-3717: headless runtimes without a stdin form (pi, cursor, muse) receive a prompt past
// inlinePromptLimitBytes as a 0600 file in the run directory and a short pointer prompt on argv,
// so spawn never fails with E2BIG.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const reviewer = 'review-pi-1';
const now = () => new Date().toISOString();

let store: Store, close: (() => Promise<void>) | undefined, url: string;
let scratch: string, root: string, bin: string, credentials: string, home: string, base: string, head: string;

const pointerStub = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const last = args.at(-1) ?? '';
const match = last.match(/^Your full instructions are in (.+?); read that file first and follow it\\.$/);
let source = 'argv', filePath = null, mode = null, prompt = last;
if (match) {
  source = 'file';
  filePath = match[1];
  mode = fs.statSync(filePath).mode & 0o777;
  prompt = fs.readFileSync(filePath, 'utf8');
}
if (!prompt) { console.error('empty prompt'); process.exit(1); }
const seen = {
  args: args.map(arg => arg.length > 256 ? '<long>' : arg),
  argvMaxBytes: Math.max(0, ...args.map(arg => Buffer.byteLength(arg, 'utf8'))),
  source,
  filePath,
  mode,
  length: Buffer.byteLength(prompt, 'utf8'),
  tail: prompt.slice(-120),
  hasDiff: prompt.includes('pi-large-diff-marker'),
};
if (process.env.RECORD_FILE) fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify(seen));
if (process.env.REVIEW_HEAD) console.log(JSON.stringify({ verdict: 'APPROVE', body: 'Reviewed head ' + process.env.REVIEW_HEAD + ' against base ' + process.env.REVIEW_BASE + '. AC-1 met: large diff reviewed on pi.', findings: [] }));
else console.log(JSON.stringify(seen));
`;

const stdinStub = `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const last = args.at(-1);
const fromStdin = last === '-p' || last === 'json' || last === undefined;
const prompt = fromStdin ? fs.readFileSync(0, 'utf8') : last;
if (!prompt) { console.error('empty prompt'); process.exit(1); }
const seen = {
  args: args.map(arg => arg.length > 256 ? '<long>' : arg),
  argvMaxBytes: Math.max(0, ...args.map(arg => Buffer.byteLength(arg, 'utf8'))),
  source: fromStdin ? 'stdin' : 'argv',
  filePath: null,
  mode: null,
  length: Buffer.byteLength(prompt, 'utf8'),
  tail: prompt.slice(-120),
  hasDiff: false,
};
if (process.env.RECORD_FILE) fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify(seen));
console.log(JSON.stringify(seen));
`;

before(async () => {
  store = await withDatabase('headless-prompt-file-fallback'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));

  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('prompt-file-fallback', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch);
  credentials = await temporaryDirectory('credentials', scratch);
  home = await temporaryDirectory('home', scratch);

  await writeFile(join(bin, 'pi'), pointerStub, { mode: 0o755 });
  await writeFile(join(bin, 'cursor-agent'), pointerStub, { mode: 0o755 });
  await writeFile(join(bin, 'muse'), pointerStub, { mode: 0o755 });
  await writeFile(join(bin, 'claude'), stdinStub, { mode: 0o755 });

  const lines = Array.from({ length: 2400 }, (_, i) => `export const graphyardSymbol_${i} = "graphyard-value-${i}-${'a'.repeat(40)}";`).join('\n') + '\n';
  const repo = await gitRepo({ root, files: { 'README.md': 'Named spec file.\n', 'sweep.ts': lines } }), git = repo.git;
  base = repo.head;
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'a-marker.ts'), 'export const marker = "pi-large-diff-marker";\n');
  await writeFile(join(root, 'sweep.ts'), lines.replaceAll('graphyard', 'mainworks'));
  git('add', 'a-marker.ts', 'sweep.ts'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'rename sweep');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);

  await setupMaster(root, { url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w', run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
});

after(async () => { await close?.(); if (store) await store.close(); if (scratch) await rm(scratch, { recursive: true, force: true }); });

const stored = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const insert = async (work: Work) => { await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]); return work; };
type Seen = { args: string[]; argvMaxBytes: number; source: string; filePath: string | null; mode: number | null; length: number; tail: string; hasDiff: boolean };

test('integration:headless-prompt-file-fallback — pi, cursor and muse receive a large prompt via a 0600 file pointer; stdin runtimes and small prompts behave as today', async () => {
  const largePrompt = `LARGE_PROMPT_START\n${'rename-sweep-line-0123456789abcdef\n'.repeat(6000)}LARGE_PROMPT_END`;
  assert.ok(Buffer.byteLength(largePrompt, 'utf8') > 131_072, 'prompt exceeds Linux MAX_ARG_STRLEN');
  const run = async (kind: string, prompt: string) => {
    const record = join(scratch, `${kind}-${prompt.length}.json`);
    const session = await startHeadlessSession({
      name: `${kind}-${prompt.length}`, work: 'GY-3717', subject: 'large prompt file fallback', kind, args: [],
      environment: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, RECORD_FILE: record },
      directory: root, contract: null, prompt, answer: async output => output, root, route: 'review', context: {}, exec: spawnHeadless,
    });
    await session.settled;
    return JSON.parse(await readFile(record, 'utf8')) as Seen;
  };

  for (const kind of ['pi', 'cursor', 'muse'] as const) {
    const large = await run(kind, largePrompt);
    assert.equal(large.source, 'file', `${kind}: a large prompt is delivered through a file pointer`);
    assert.ok(!large.args.includes('<long>'), `${kind}: the large prompt is not on argv`);
    assert.ok(large.argvMaxBytes < 512, `${kind}: argv carries only the short pointer prompt`);
    assert.ok(large.filePath?.includes('.graphyard'), `${kind}: prompt file lives in the run directory`);
    assert.equal(large.mode, 0o600, `${kind}: prompt file has mode 0600`);
    assert.ok(large.length >= Buffer.byteLength(largePrompt, 'utf8'), `${kind}: the file holds the whole prompt`);
    assert.ok(large.tail.includes('LARGE_PROMPT_END'), `${kind}: the prompt tail is intact`);

    const small = await run(kind, 'Small prompt check');
    assert.equal(small.source, 'argv', `${kind}: a small prompt stays on argv as today`);
    assert.ok(small.tail.includes('Small prompt check'));
  }

  const claudeLarge = await run('claude', largePrompt);
  assert.equal(claudeLarge.source, 'stdin', 'claude keeps using stdin for large prompts');
  assert.ok(claudeLarge.length >= Buffer.byteLength(largePrompt, 'utf8'));
});

test('e2e:headless-prompt-file-fallback — a review of a change with a very large diff run on pi posts a verdict', async () => {
  const record = join(scratch, 'pi-review-record.json');
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', {
    runtimes: [{ name: 'pi', launch: { kind: 'pi', args: [],
      environment: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, RECORD_FILE: record, REVIEW_HEAD: head, REVIEW_BASE: base }, homeVariable: 'PI_CODING_AGENT_DIR', modelFlag: '--model' } }],
    models: [{ name: 'pi-default', id: 'zai/glm-5.3-flash' }],
    accounts: [{ name: 'reviewer-pi', runtime: 'pi', model: 'pi-default', credential: { host: config.hostId, home } }],
    roles: [{ name: 'reviewer', accounts: ['reviewer-pi'], concurrency: 4 }],
    reason: 'pi large prompt review',
  }, randomUUID());
  await new AgentRegistry(store).observe(coordinator, { host: config.hostId, observations: [{ account: 'reviewer-pi', quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } }] }, randomUUID());
  await saveReviewerProfile(root, { name: 'reviewer-pi', agentName: reviewer, kind: 'pi', agentArgs: [] });

  const candidate = { sha: head, baseSha: base, pr: 94, branch: 'graphyard/gy-3594-1', author: 'graphyard-claude-1' };
  const work = await insert(workFixture({ id: randomUUID(), key: 'GY-9717', title: 'Large rename sweep', priority: 1, systemDriven: undefined,
    criteria: [{ id: 'AC-1', text: `Rename sweep criterion: ${'every reference in module group updated cleanly without regression; '.repeat(1100)}`, proofs: ['unit:works'] }],
    stage: 'review', revision: 3, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), epoch: 1, candidate, submission: { epoch: 1, pr: 94 }, gates: [], implementers: ['graphyard-claude-1'],
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }],
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['sweep.ts'], scopeFiles: [{ path: 'sweep.ts', status: 'modified', sha: head, additions: 2401, deletions: 2400, binary: false }], baseTip: base, baseTipContained: true },
  } as never));

  const run = (command: string, args: string[], options?: { cwd?: string }) => {
    if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
    throw new Error(`no ${command} here: a headless launch opens no pane`);
  };
  const launched = await launchReview(root, work, 'reviewer-pi', [], now(), { run, headless: spawnHeadless, requestId: 'pi-large-diff-review' });
  await until(async () => (await readReviewLedger(root)).reviews.some(entry => entry.id === launched.review && !liveRun(entry.agentName) && (entry.verdict || entry.state !== 'pending')), 'the pi review to settle', 10_000, 25);
  const entry = (await readReviewLedger(root)).reviews.find(review => review.id === launched.review)!;
  assert.equal(entry.verdict?.state, 'APPROVED', entry.resolution);
  assert.equal(entry.verdict?.reviewer, reviewer);

  const seen = JSON.parse(await readFile(record, 'utf8')) as Seen;
  assert.ok(seen.length > 131_072, `expected review prompt > 131072 bytes, got ${seen.length}`);
  assert.equal(seen.source, 'file');
  assert.equal(seen.mode, 0o600);
  assert.equal(seen.hasDiff, true, 'review prompt carried the diff');

  const [review] = (await stored(work.id)).observation!.reviews as { reviewer: string; sha: string; state: string }[];
  assert.deepEqual([review!.reviewer, review!.sha, review!.state], [reviewer, head, 'APPROVED']);
});
