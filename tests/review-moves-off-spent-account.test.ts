import { after, before } from 'node:test';
import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { spawnHeadless } from '../src/headless-session.js';
import { loadMasterConfig, setupMaster, type MasterConfig } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { liveRun } from '../src/runner/registry.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { dispatchEffects } from '../src/dispatch/effects.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { listen } from './helpers/http-server.js';

// GY-3748 AC-2: marks the first reviewer account exhausted after its launch was requested
// and asserts another account posts the verdict within the case.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
let store: Store, close: (() => Promise<void>) | undefined, registry: AgentRegistry, hostId: string, url: string;
let root: string, scratch: string, base: string, head: string, homeA: string, homeB: string, previousPath: string | undefined;

before(async () => {
  store = await withDatabase('review-moves-off-spent'); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));
  root = await temporaryDirectory('review-moves-root');
  scratch = await temporaryDirectory('review-moves-scratch');
  const { git } = await gitRepo({ root });
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'Spec.\n');
  git('add', 'README.md'); git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  await writeFile(join(root, 'feature.ts'), 'export const moved = true;\n');
  git('add', 'feature.ts'); git('commit', '-qm', 'head');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-q', base);
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  await setupMaster(root, {
    url, token: coordinatorToken, cliPath: launcher,
    credentialDirectory: join(scratch, 'credentials'), herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('review-moves-checkouts', join(process.cwd(), '.graphyard')) },
  });
  hostId = (await loadMasterConfig(root)).hostId;
  homeA = join(scratch, 'claude-a');
  homeB = join(scratch, 'claude-b');
  await mkdir(homeA); await writeFile(join(homeA, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'stub-a' } }));
  await mkdir(homeB); await writeFile(join(homeB, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'stub-b' } }));
  const bin = join(scratch, 'bin');
  await mkdir(bin);
  // Stub claude: homeA is exhausted (refuses with usage limit); homeB answers with a valid review verdict JSON.
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const dir = process.env.CLAUDE_CONFIG_DIR || '';
if (dir === ${JSON.stringify(homeA)}) {
  console.error('Usage limit reached; resets at ' + new Date(Date.now() + 3_600_000).toISOString());
  process.exit(1);
}
if (process.argv.includes('Reply with the single word OK.')) {
  console.log('OK');
  process.exit(0);
}
appendFileSync(${JSON.stringify(join(scratch, 'ran'))}, dir + '\\n');
console.log(JSON.stringify({
  verdict: 'APPROVE',
  body: 'Reviewed head ${head} against base ${base}. AC-1 met: feature.ts exports moved.',
  findings: [],
}));
`, { mode: 0o755 });
  previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  registry = new AgentRegistry(store);
  await registry.mutate(coordinator, 'apply', {
    runtimes: proposedRuntimes.filter(r => r.name === 'claude'),
    models: [{ name: 'opus', id: 'opus', provider: 'anthropic' }],
    accounts: [
      { name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: hostId, home: homeA } },
      { name: 'claude-b', runtime: 'claude', model: 'opus', credential: { host: hostId, home: homeB } },
    ],
    roles: [{ name: 'reviewer', accounts: ['claude-a', 'claude-b'], concurrency: 4, policy: { args: ['--setting-sources', 'user'] } }],
    reason: 'two claude reviewers',
  }, randomUUID());
  // Profile named after claude-a — launch must still follow the registry's reviewer role and skip exhausted claude-a.
  await saveReviewerProfile(root, { name: 'review-claude-a', agentName: 'review-claude-a', kind: 'claude', agentArgs: ['--setting-sources', 'user'] });
});

after(async () => {
  process.env.PATH = previousPath;
  await close?.();
  if (store) await store.close();
  for (const dir of [root, scratch]) if (dir) await rm(dir, { recursive: true, force: true });
});

const gitRun = (command: string, args: string[], options?: { cwd?: string }) => {
  if (command === 'git') return execFileSync(command, args, { encoding: 'utf8', cwd: options?.cwd });
  throw new Error(`unexpected ${command}`);
};

test('e2e:review-moves-off-spent-account — marks first reviewer exhausted after launch was requested and asserts another account posts the verdict', async () => {
  const at = now();
  const candidate = { sha: head, baseSha: base, pr: 17, branch: 'graphyard/gy-9601-1', author: 'graphyard-worker-1' };
  const work: Work = {
    id: randomUUID(), key: 'GY-9601', title: 'Review moves off spent account', description: '', type: 'bug', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'feature.ts exports moved', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: hostId, path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-worker-1' }],
    candidate, submission: { epoch: 1, pr: 17 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['graphyard-worker-1'],
    autoDispatch: {
      review: { id: 'req-9601', kind: 'review', provider: 'github', pr: 17, sha: head, baseSha: base, policyRevision: 1, state: 'requested', requestedAt: at, reason: 'review required' },
      producers: [], history: [],
    },
    observation: {
      source: 'control-plane', at, candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['feature.ts'], scopeFiles: [{ path: 'feature.ts', status: 'added', sha: head, additions: 1, deletions: 0, binary: false }], baseTip: base, baseTipContained: true,
    },
  } as unknown as Work;
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);

  // After the review launch is requested, mark the first reviewer account (claude-a) exhausted until later.
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await registry.mutate(coordinator, 'account.quota', {
    name: 'claude-a', quota: { state: 'exhausted', resetsAt }, reason: 'weekly limit reached',
  }, randomUUID());

  const config = await loadMasterConfig(root) as MasterConfig;
  const mutate = async (path: string, body: unknown) => {
    const res = await fetch(`${url}/api/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${coordinatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body),
    });
    const parsed = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(parsed));
    return parsed;
  };
  const loadItem = async () => (await store.pool.query('SELECT document FROM work_items WHERE id = $1', [work.id])).rows[0].document as Work;
  const baseEffects = dispatchEffects(root, () => config, {
    snapshot: async () => ({ work: [await loadItem()], now: now() }),
    mutate, run: gitRun, headless: spawnHeadless,
  });
  const effects = {
    ...baseEffects,
    inventory: async () => ({ available: true, agents: [], panes: [], sessions: [] }),
    agents: async () => [],
  };
  const cursor = emptyDispatchCursor(config);
  const tick = await runDispatchTick(config, cursor, effects, Date.now);
  assert.equal(tick.launched.length, 1, `expected review to launch: ${JSON.stringify(tick)}`);

  // Wait for the headless reviewer to finish and post its verdict.
  let record: Awaited<ReturnType<typeof readReviewLedger>>['reviews'][number] | undefined;
  for (let i = 0; i < 400; i++) {
    record = (await readReviewLedger(root)).reviews.find(r => r.key === 'GY-9601');
    if (record && !liveRun(record.agentName) && (record.verdict || record.state !== 'pending')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(record?.verdict?.state, 'APPROVED', 'the review verdict is posted');
  const ran = (await readFile(join(scratch, 'ran'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  assert.deepEqual(ran, [homeB], 'claude-a never ran; claude-b ran and posted the verdict');
  const updated = await loadItem();
  assert.equal(updated.reviewLaunch?.verdict?.state, 'APPROVED', 'control plane recorded the verdict');
});
