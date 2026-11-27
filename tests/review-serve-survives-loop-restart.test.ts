import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import type { Principal, Work } from '../src/model.js';
import { readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { startReviewServe } from '../src/review-serve.js';
import { EventEmitter } from 'node:events';
import { listen } from './helpers/http-server.js';
import { workFixture } from './helpers/work-fixture.js';
import { observationFixture } from './helpers/observation-fixture.js';
import { until } from './helpers/until.js';

// GY-3662: a product review's served head survives a loop restart, so a deploy does not void
// reviews in flight. The serve command runs detached in its own unit/session, is recorded with
// the review session, keeps answering at the same address across the loop restart, and stops
// once the restarted loop adopts and finishes the review session.

const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const coordinatorToken = `${coordinator.id}-token-${'x'.repeat(32)}`;
const now = () => new Date().toISOString();
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const declaredPort = 4419, declaredUrl = `http://127.0.0.1:${declaredPort}/healthz`;

let store: Store, close: (() => Promise<void>) | undefined, url: string;
let root: string, credentials: string, browserBin: string, helperDir: string;
let base: string, head: string;

before(async () => {
  store = await withDatabase('review-serve-survives-loop-restart');
  await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = null;
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: coordinatorToken }])));

  ({ root, head: base } = await gitRepo({ label: 'review-serve-restart-root', files: { 'README.md': 'project\n' } }));
  credentials = await temporaryDirectory('review-serve-restart-credentials');
  browserBin = await temporaryDirectory('review-serve-restart-bin');
  helperDir = await temporaryDirectory('review-serve-restart-helper');

  await writeFile(join(browserBin, 'agent-browser'), '#!/bin/sh\necho browser\n', { mode: 0o755 });

  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git'); git(root, 'update-ref', 'refs/remotes/origin/main', base);

  await writeFile(join(root, 'graphyard.json'), JSON.stringify({
    e2e: { serve: { command: 'node serve-it.mjs', url: declaredUrl, readySeconds: 30 } },
  }, null, 2));
  // Real app servers log each request to stdout; a serve tied to the loop's pipe dies on EPIPE once the loop exits.
  await writeFile(join(root, 'serve-it.mjs'), `import { createServer } from 'node:http';
const port = Number(process.env.GRAPHYARD_E2E_SERVE_PORT) || ${declaredPort};
const srv = createServer((request, response) => {
  console.log('served', request.method, request.url);
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(\`<h1>candidate-marker: gy-3662 on \${port}</h1>\`);
});
srv.listen(port, '127.0.0.1', () => {
  console.log('listening', port);
});
`);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'candidate head'); head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', base);

  await setupMaster(root, {
    url, token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w',
    run: { worktreeRoot: await temporaryDirectory('review-serve-restart-checkouts'), reviewerProfile: 'product-claude' },
  });
  const config = await loadMasterConfig(root);
  await new AgentRegistry(store).mutate(coordinator, 'apply', {
    runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'),
    models: [{ name: 'opus', id: 'opus' }],
    accounts: [{ name: 'product-claude-account', runtime: 'claude', model: 'opus', credential: { host: config.hostId, home: null } }],
    roles: [{ name: 'reviewer', accounts: ['product-claude-account'], concurrency: 8, policy: {} }],
    reason: 'fixture',
  }, randomUUID());
  await saveReviewerProfile(root, { name: 'product-claude', agentName: 'product-claude-1', kind: 'claude', agentArgs: [], accounts: ['product-claude-account'] });
});

after(async () => {
  await close?.();
  if (store) await store.close();
  for (const dir of [root, credentials, browserBin, helperDir]) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function productItem(key: string): Promise<Work> {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: `graphyard/${key.toLowerCase()}-1`, author: 'graphyard-claude-1' };
  const work = workFixture({ id: randomUUID(), key, title: `Item ${key}`, priority: 1,
    criteria: [{ id: 'AC-1', text: 'The feature works for the person using it', proofs: ['integration:review-serve-survives-loop-restart'] }],
    stage: 'review', revision: 3, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), epoch: 1,
    workspaces: [{ host: 'h', path: '/w', branch: candidate.branch, epoch: 1, owner: 'graphyard-claude-1' }], candidate, submission: { epoch: 1, pr: 7 },
    gates: [], implementers: ['graphyard-claude-1'], pipeline: { attempts: [], submittedAt: null, resubmittedAt: null, reworkRounds: 0, interventions: { blocked: 0, requirements: 0 } },
    observation: observationFixture(candidate, { source: 'control-plane', protected: false,
      files: ['serve-it.mjs'], scopeFiles: [{ path: 'serve-it.mjs', status: 'modified', sha: head, additions: 1, deletions: 0, binary: false }] }),
  });
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
}

const answers = (address: string) => fetch(address, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);

test('integration:review-serve-survives-loop-restart — a product review served head survives a loop restart, posts a verdict through the restarted loop, and stops when the session ends', { timeout: 90_000 }, async () => {
  const work = await productItem('GY-9662');
  const startedFile = join(helperDir, 'reviewer-started.json');
  const releaseFile = join(helperDir, 'reviewer-release');
  const loop1ReadyFile = join(helperDir, 'loop1-ready');
  const loop2DoneFile = join(helperDir, 'loop2-done.json');

  // Fake claude runtime: records the served address it was given, waits across the loop restart,
  // then fetches that same address and posts APPROVE only if the served head still answers.
  const fakeClaude = join(browserBin, 'claude');
  await writeFile(fakeClaude, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
const prompt = process.argv.slice(2).join(' ');
const match = prompt.match(/served for this review at (http:\\/\\/127\\.0\\.0\\.1:\\d+)/);
const url = match ? match[1] : null;
writeFileSync(${JSON.stringify(startedFile)}, JSON.stringify({ url, pid: process.pid }));
while (!existsSync(${JSON.stringify(releaseFile)})) {
  await new Promise(resolve => setTimeout(resolve, 50));
}
let ok = false, body = '';
if (url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    body = await res.text();
    ok = res.ok && body.includes('candidate-marker: gy-3662');
  } catch (error) {
    body = String(error);
  }
}
if (ok) {
  console.log(JSON.stringify({ verdict: 'APPROVE', body: 'Walked ' + url + ' after restart: ' + body, findings: [] }));
} else {
  console.log(JSON.stringify({ verdict: 'COULD_NOT_RUN', body: 'The served head at ' + url + ' is not running: ' + body, findings: [] }));
}
`, { mode: 0o755 });

  // Child loop script: mode "launch" starts the product review and stays alive until SIGTERM (when it detaches runs and exits);
  // mode "adopt" starts a fresh loop process that adopts the detached review session and waits for it to settle.
  const loopScript = join(helperDir, 'loop-process.mts');
  await writeFile(loopScript, `import { writeFileSync } from 'node:fs';
import { launchReview, headlessReviewAdopter } from ${JSON.stringify(fileURLToPath(new URL('../src/reviewer.ts', import.meta.url)))};
import { spawnHeadless, adoptHeadlessSessions } from ${JSON.stringify(fileURLToPath(new URL('../src/headless-session.ts', import.meta.url)))};
import { detachRuns } from ${JSON.stringify(fileURLToPath(new URL('../src/runner/registry.ts', import.meta.url)))};

const mode = process.argv[2];
const payload = JSON.parse(process.argv[3]);

if (mode === 'launch') {
  const launched = await launchReview(payload.root, payload.work, 'product-claude', [], new Date().toISOString(), {
    headless: spawnHeadless,
    product: true,
  });
  writeFileSync(payload.readyFile, JSON.stringify(launched));
  const keepAlive = setInterval(() => {}, 60_000);
  process.once('SIGTERM', () => {
    clearInterval(keepAlive);
    detachRuns();
    process.exit(0);
  });
} else if (mode === 'adopt') {
  const adopted = adoptHeadlessSessions(payload.root, { review: headlessReviewAdopter(payload.root) });
  await Promise.all(adopted.map(entry => entry.settled));
  writeFileSync(payload.doneFile, JSON.stringify({ adopted: adopted.length }));
  process.exit(0);
}
`);

  const childEnv = { ...process.env, PATH: `${browserBin}:${process.env.PATH ?? ''}`, NODE_TEST_CONTEXT: '1' };
  let loop1: ChildProcess | undefined, loop2: ChildProcess | undefined;
  let loop1Err = '', loop2Err = '';
  const killChild = async (child: ChildProcess | undefined) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  };

  try {
    // 1. Loop 1 launches the product review (which starts the head's serve command and the reviewer session).
    loop1 = spawn(process.execPath, ['--import', 'tsx', loopScript, 'launch', JSON.stringify({ root, work, readyFile: loop1ReadyFile })], {
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    loop1.stderr!.on('data', chunk => { loop1Err += chunk; });

    await until(() => existsSync(loop1ReadyFile) && existsSync(startedFile) || loop1!.exitCode !== null, 'Loop 1 to launch review and reviewer session to start', 30_000, 50);
    assert.equal(loop1.exitCode, null, `Loop 1 exited unexpectedly: ${loop1Err}`);
    const started = JSON.parse(await readFile(startedFile, 'utf8')) as { url: string | null; pid: number };
    assert.ok(started.url, 'reviewer prompt must include the served head URL');
    const servedUrl = started.url;
    assert.equal(await answers(servedUrl), true, 'served head answers before loop restart');

    // 2. Restart the loop: SIGTERM Loop 1 and wait for it to exit.
    await killChild(loop1);

    // 3. After Loop 1 is gone, the served head must STILL answer at the exact same address across requests.
    const probe1 = await answers(servedUrl);
    const probe2 = await answers(servedUrl);
    assert.equal(probe1 && probe2, true, `served head at ${servedUrl} must still answer after loop restart (probe1=${probe1}, probe2=${probe2})`);

    // 4. Loop 2 starts fresh and adopts the in-flight review session.
    loop2 = spawn(process.execPath, ['--import', 'tsx', loopScript, 'adopt', JSON.stringify({ root, doneFile: loop2DoneFile })], {
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    loop2.stderr!.on('data', chunk => { loop2Err += chunk; });

    // 5. Release the reviewer session so it walks the served head after the restart and posts its verdict.
    await writeFile(releaseFile, 'go');
    await until(() => loop2!.exitCode !== null, 'Loop 2 to adopt and settle the review', 30_000, 50);
    assert.equal(loop2.exitCode, 0, `Loop 2 failed: ${loop2Err}`);
    const adopted = JSON.parse(await readFile(loop2DoneFile, 'utf8')) as { adopted: number };
    assert.equal(adopted.adopted, 1, 'Loop 2 adopted the in-flight product review session');

    // 6. The verdict is recorded on the work item and in the review ledger.
    const stored = (await store.pool.query('SELECT document FROM work_items WHERE id = $1', [work.id])).rows[0]?.document as Work | undefined;
    assert.equal(stored?.productReview?.verdict, 'approved', `expected approved product verdict, got ${JSON.stringify(stored?.productReview)}`);
    const ledger = await readReviewLedger(root);
    assert.ok(ledger.reviews.some(record => record.key === work.key && record.verdict?.state === 'APPROVED'), 'review ledger recorded APPROVED verdict');

    // 7. Once the review session ends, the served head must stop answering.
    await until(async () => !(await answers(servedUrl)), 'the served head to stop after review session ended', 10_000, 50);
  } finally {
    await killChild(loop1);
    await killChild(loop2);
  }
});

test('integration:review-serve-survives-loop-restart — under systemd containment the review serve launches in its own transient scope', async () => {
  const spawned: { file: string; args: readonly string[]; detached?: boolean; stdio?: unknown }[] = [];
  const fakeSpawn = ((file: string, args: readonly string[], options: { detached?: boolean; stdio?: unknown }) => {
    spawned.push({ file, args, detached: options?.detached, stdio: options?.stdio });
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref() {} });
    queueMicrotask(() => child.emit('error', new Error('stubbed spawn')));
    return child;
  }) as unknown as typeof spawn;
  await assert.rejects(
    startReviewServe({
      root,
      id: 'scope-check',
      worktree: root,
      serve: { command: 'node serve-it.mjs', url: 'http://127.0.0.1:4499/healthz', readySeconds: 5 },
      env: {},
      containment: 'systemd',
      spawn: fakeSpawn,
    }),
    /stubbed spawn/,
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.file, 'systemd-run');
  assert.deepEqual(spawned[0]!.args.slice(0, 5), ['--user', '--scope', '--quiet', '--collect', '--unit=graphyard-run-review-serve-scope-check.scope']);
  assert.equal(spawned[0]!.detached, true);
  assert.deepEqual(spawned[0]!.stdio, ['ignore', 'ignore', 'ignore']);
});
