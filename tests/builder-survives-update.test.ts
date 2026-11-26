// GY-3785 AC-2: the quiet-update wait counts running builder sessions as work in flight with the
// same 4-hour upper bound, and a stub builder session under `watch` survives a control-plane
// restart mid-item and submits without a new attempt.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { workerRunsDirectory } from '../src/headless-session.js';
import { processIdentity, runFiles } from '../src/runner/pi.js';
import { installInFlight } from '../src/cli/upgrade.js';
import { controlPlaneRecordPath, controlPlaneSummary, deployOnce, deployRecordPath, readControlPlaneRecord, writeControlPlaneRecord, type DeployWatchPorts } from '../src/deploy-watch.js';
import { loopStateContext } from '../src/loop-state.js';
import { mainworksRepository } from '../src/scenarios.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const listen = (http: Server, port = 0) => new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve));
const close = (http: Server) => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
const portOf = (http: Server) => (http.address() as { port: number }).port;

test('e2e:builder-survives-update — quiet-update wait counts running builder sessions as in flight with a 4-hour upper bound', async t => {
  const root = await temporaryDirectory('quiet-builder-wait');
  const slots = await temporaryDirectory('quiet-builder-slots');
  const runId = randomUUID();
  const runDir = join(workerRunsDirectory(root), runId);
  mkdirSync(runDir, { recursive: true });

  // Spawn a real stub process so runAlive(meta) sees a live builder session.
  const stub = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { stub.kill('SIGKILL'); } catch {} });

  writeFileSync(join(runDir, 'session.json'), JSON.stringify({
    id: runId, name: 'builder-1', work: 'GY-1', epoch: 1, principal: 'worker-1',
    account: null, kind: 'codex', subject: 'GY-1: stub builder', startedAt: new Date().toISOString(),
  }));
  writeFileSync(runFiles(runDir).meta, JSON.stringify({
    version: 1, id: runId, command: process.execPath, pid: stub.pid,
    identity: processIdentity(stub.pid!), containment: 'setsid', unit: null,
    startedAt: new Date().toISOString(), timeoutMs: 60_000, exitGraceMs: 0,
  }));

  await loopStateContext.run(() => ({ read: async () => [], write: async () => {} }), async () => {
    const busy = await installInFlight(root, 'owner/consumer', slots);
    assert.equal(busy, 'a builder is running', 'running builder session counts as in flight');

    // Verify 4-hour upper bound via deployOnce with mocked Date.
    const a = 'a'.repeat(40), b = 'b'.repeat(40);
    const start = Date.parse('2026-11-24T12:00:00.000Z');
    mock.timers.enable({ apis: ['Date'], now: start });
    t.after(() => mock.timers.reset());

    const file = deployRecordPath(root);
    await writeControlPlaneRecord(controlPlaneRecordPath(root), {
      commit: a, updatedAt: new Date(start - 2 * 3_600_000).toISOString(),
      checkedAt: null, verified: a, verifiedSeenAt: null, failedStep: null, failedReason: null, failedAt: null,
    });
    const restarts: string[] = [];
    const ports: DeployWatchPorts = {
      fetch: async () => a, head: async () => a, verifiedUpstream: async () => b,
      busy: () => installInFlight(root, 'owner/consumer', slots), hotfix: async () => false,
      build: async () => {}, restart: async commit => { restarts.push(commit); },
      health: async () => {}, checkout: async () => {}, pin: async () => {}, prune: async () => {},
      schema: async () => 1, database: async () => 1,
    };

    assert.equal(await deployOnce(file, ports, () => {}, mainworksRepository), 'unchanged');
    assert.deepEqual(restarts, [], 'update waits while builder is running');
    assert.match(controlPlaneSummary(readControlPlaneRecord(controlPlaneRecordPath(root)), Date.now())?.waiting ?? '', /a builder is running/);

    mock.timers.tick(119 * 60_000);
    assert.equal(await deployOnce(file, ports, () => {}, mainworksRepository), 'unchanged', 'still waits just before 4 hours since the last update');
    mock.timers.tick(1 * 60_000);
    assert.equal(await deployOnce(file, ports, () => {}, mainworksRepository), 'deployed', 'updates at the 4-hour upper bound from the last update');
    assert.deepEqual(restarts, [b]);

    // Once the builder exits, installInFlight is quiet.
    writeFileSync(runFiles(runDir).exit, '0');
    assert.equal(await installInFlight(root, 'owner/consumer', slots), null, 'exited builder is no longer in flight');
  });
});

test('e2e:builder-survives-update — restarts the control plane mid-item and asserts the builder submits without a new attempt', { timeout: 120_000 }, async () => {
  const worktree = await temporaryDirectory('builder-survives-wt');
  const startedMarker = join(worktree, 'started');
  const submitMarker = join(worktree, 'submit-now');
  const store = await withDatabase('builder-survives-update');
  await store.init();

  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]) => execFileSync('git', ['-C', worktree, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('commit', '--allow-empty', '--quiet', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('commit', '--allow-empty', '--quiet', '-m', 'builder work');
  const head = git('rev-parse', 'HEAD');

  type Credential = Principal & { token: string };
  const operator: Credential = { id: 'e2e-operator', role: 'admin', sessionKind: 'human', token: 'e2e-op-'.padEnd(40, 'x') };
  const worker: Credential = { id: 'e2e-builder', role: 'worker', sessionKind: 'ai', token: 'e2e-wk-'.padEnd(40, 'x') };

  let engine = new Engine(store, 3, 'owner/project');
  engine.principals = [operator, worker];
  engine.gitRunner = gitRunnerFor(worktree);
  let stopBeat = await engine.startPlaneBeat(500);
  let http: Server | undefined = server(engine, [operator, worker]);
  await listen(http);
  const port = portOf(http);
  const base = `http://127.0.0.1:${port}`;

  let watchChild: ReturnType<typeof spawn> | undefined;
  try {
    let work = await engine.execute(operator, 'create', null, {
      title: 'Builder survives update', type: 'bug',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }],
    }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    const epoch = work.epoch;
    work = await engine.execute(worker, 'workspace', work.id, {
      epoch, host: 'e2e-host', path: worktree, branch: `graphyard/${work.key.toLowerCase()}-${epoch}`,
    }, randomUUID());

    // Stub builder runs under `mainworks watch`, signals when started, waits for submitMarker, then submits.
    const builderScript = `
      const fs = require('node:fs');
      const { randomUUID } = require('node:crypto');
      fs.writeFileSync(${JSON.stringify(startedMarker)}, 'started');
      const timer = setInterval(async () => {
        if (!fs.existsSync(${JSON.stringify(submitMarker)})) return;
        clearInterval(timer);
        const res = await fetch(${JSON.stringify(`${base}/api/work/${work.id}/submit`)}, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + process.env.GRAPHYARD_TOKEN, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ epoch: ${epoch}, head: ${JSON.stringify(head)} }),
        });
        if (!res.ok) { console.error(await res.text()); process.exit(2); }
        process.exit(0);
      }, 100);
    `;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GRAPHYARD_URL: base,
      GRAPHYARD_TOKEN: worker.token!,
      GRAPHYARD_HOST_ID: 'e2e-host',
    };
    delete env.GRAPHYARD_TOKEN_FILE;

    let stderr = '';
    watchChild = spawn(process.execPath, [launcher, 'watch', work.key, String(epoch), '--', process.execPath, '-e', builderScript], {
      cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    watchChild.stderr?.on('data', chunk => { stderr += chunk; });
    let exited: number | null = null;
    const watchDone = new Promise<number>(resolve => watchChild!.on('close', code => { exited = code ?? 1; resolve(exited); }));

    // Wait for the stub builder to start under watch.
    for (const start = Date.now(); exited === null; await delay(50)) {
      try {
        const { existsSync } = await import('node:fs');
        if (existsSync(startedMarker)) break;
      } catch {}
      if (Date.now() - start > 15_000) assert.fail(`stub builder did not start: ${stderr}`);
    }
    assert.equal(exited, null, `watch exited early before restart: ${stderr}`);

    // Restart the control plane: stop it for 5s (longer than the 3s lease!) then bring a fresh Engine + server back up.
    stopBeat();
    await close(http);
    http = undefined;
    await delay(5_000);
    assert.equal(exited, null, `watch killed builder during control plane restart: ${stderr}`);

    engine = new Engine(store, 3, 'owner/project');
    engine.principals = [operator, worker];
    engine.gitRunner = gitRunnerFor(worktree);
    stopBeat = await engine.startPlaneBeat(500);
    http = server(engine, [operator, worker]);
    await listen(http, port);

    // Run reconcile right after restart — the builder must still keep its item and renew on epoch 1.
    await engine.reconcile();
    await delay(1_500);
    assert.equal(exited, null, `watch killed builder after control plane restarted: ${stderr}`);

    // Signal the stub builder to submit.
    await writeFile(submitMarker, 'go');
    const code = await watchDone;
    assert.equal(code, 0, `watch exited with ${code}: ${stderr}`);

    const finalWork: Work = (await store.list()).find(item => item.id === work.id)!;
    assert.equal(finalWork.submission?.epoch, epoch, 'item submitted by the original builder session on epoch 1');
    assert.equal(finalWork.epoch, epoch, 'no new epoch');
    assert.equal(finalWork.pipeline?.attempts.length, 1, 'submitted without a new attempt');
    assert.equal(finalWork.pipeline?.attempts[0]?.end, 'submitted');
  } finally {
    try { watchChild?.kill('SIGKILL'); } catch {}
    stopBeat();
    if (http) await close(http);
    await store.close();
  }
});
