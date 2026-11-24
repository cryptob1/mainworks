// GY-3785 AC-1: a builder session whose lease renewal fails with a connection error or 5xx keeps
// working and retries for up to 5 minutes; the server accepts a renewal for a lease that lapsed
// while it was not serving, provided the item's epoch is unchanged and no other session claimed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { supervise } from '../src/session-watch.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

type Credential = Principal & { token: string };
const operator: Credential = { id: 'human-operator', role: 'admin', sessionKind: 'human', token: 'op-token-'.padEnd(40, 'x') };
const workerA: Credential = { id: 'builder-a', role: 'worker', sessionKind: 'ai', token: 'wa-token-'.padEnd(40, 'x') };
const workerB: Credential = { id: 'builder-b', role: 'worker', sessionKind: 'ai', token: 'wb-token-'.padEnd(40, 'x') };

const listen = (http: Server, port = 0) => new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve));
const close = (http: Server) => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
const portOf = (http: Server) => (http.address() as { port: number }).port;

async function postJson(url: string, token: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  if (!response.ok) {
    throw Object.assign(new Error(JSON.stringify(parsed)), {
      status: response.status,
      confirmedRefusal: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429,
    });
  }
  return parsed;
}

test('unit:lease-survives-control-plane-restart — stops a stub server for 90 seconds mid-session and asserts the session ends submitted on the same epoch', { timeout: 180_000 }, async () => {
  const dir = await temporaryDirectory('lease-survives-restart');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('commit', '--allow-empty', '--quiet', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('commit', '--allow-empty', '--quiet', '-m', 'builder work');
  const head = git('rev-parse', 'HEAD');
  const submitMarker = join(dir, 'submit-now');
  const submittedMarker = join(dir, 'submitted');
  const store = await withDatabase('lease-survives-restart');
  await store.init();

  let engine = new Engine(store, 30, 'owner/project');
  engine.principals = [operator, workerA, workerB];
  engine.gitRunner = gitRunnerFor(dir);
  let stopBeat = await engine.startPlaneBeat(5_000);
  let http: Server | undefined = server(engine, [operator, workerA, workerB]);
  await listen(http);
  const port = portOf(http);
  const base = `http://127.0.0.1:${port}`;

  try {
    let work = await engine.execute(operator, 'create', null, {
      title: 'Survive 90s restart', type: 'bug',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }],
    }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(workerA, 'claim', work.id, {}, randomUUID());
    const epoch = work.epoch;
    work = await engine.execute(workerA, 'workspace', work.id, {
      epoch, host: 'test-host', path: dir, branch: `graphyard/${work.key.toLowerCase()}-${epoch}`,
    }, randomUUID());

    // Stub builder keeps working until submitMarker appears, then submits on the same epoch and exits 0.
    const builderScript = `
      const fs = require('node:fs');
      const { randomUUID } = require('node:crypto');
      const timer = setInterval(async () => {
        if (!fs.existsSync(${JSON.stringify(submitMarker)})) return;
        clearInterval(timer);
        const res = await fetch(${JSON.stringify(`${base}/api/work/${work.id}/submit`)}, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + ${JSON.stringify(workerA.token)}, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ epoch: ${epoch}, head: ${JSON.stringify(head)} }),
        });
        if (!res.ok) { console.error(await res.text()); process.exit(2); }
        fs.writeFileSync(${JSON.stringify(submittedMarker)}, 'submitted');
        process.exit(0);
      }, 100);
    `;

    let settled = false;
    let renewals = 0;
    const supervising = supervise(
      process.execPath,
      ['-e', builderScript],
      epoch,
      async () => {
        const result = await postJson(`${base}/api/work/${work.id}/heartbeat`, workerA.token!, { epoch });
        renewals++;
        return result;
      },
      { intervalMs: 5_000, retryMs: 500, retryMaxMs: 2_000, graceMs: 500, session: {} },
    );
    void supervising.then(() => { settled = true; }, () => { settled = true; });

    // Wait for initial renewal so the builder is running mid-session.
    for (const start = Date.now(); renewals < 1 && !settled; await delay(50)) {
      if (Date.now() - start > 10_000) assert.fail('initial renewal never landed');
    }
    assert.equal(settled, false, 'builder is running before downtime');

    // Stop the stub server for 90 seconds mid-session (well past the 30s lease).
    stopBeat();
    await close(http);
    http = undefined;
    await delay(90_000);
    assert.equal(settled, false, 'builder kept working through 90s server downtime');

    // Restart the server on the same port with a fresh Engine against the same Store.
    engine = new Engine(store, 30, 'owner/project');
    engine.principals = [operator, workerA, workerB];
    engine.gitRunner = gitRunnerFor(dir);
    stopBeat = await engine.startPlaneBeat(5_000);
    http = server(engine, [operator, workerA, workerB]);
    await listen(http, port);

    // Wait for a renewal to succeed after restart.
    const beforeRecovery = renewals;
    for (const start = Date.now(); renewals <= beforeRecovery && !settled; await delay(100)) {
      if (Date.now() - start > 15_000) assert.fail('renewal did not recover after server restarted');
    }
    assert.equal(settled, false, 'builder is still running after renewal recovered');

    // Signal the stub builder to submit on the same epoch.
    await writeFile(submitMarker, 'go');
    const exitCode = await supervising;
    assert.equal(exitCode, 0, 'supervised builder exited cleanly after submitting');

    const finalWork: Work = (await store.list()).find(item => item.id === work.id)!;
    assert.equal(finalWork.submission?.epoch, epoch, 'item was submitted on the same epoch');
    assert.equal(finalWork.epoch, epoch, 'epoch did not increment');
    assert.equal(finalWork.pipeline?.attempts.length, 1, 'no new attempt was created');
    assert.equal(finalWork.pipeline?.attempts[0]?.end, 'submitted', 'attempt ended as submitted');
  } finally {
    stopBeat();
    if (http) await close(http);
    await store.close();
  }
});

test('unit:lease-survives-control-plane-restart — renewal is still refused when another session claimed the item, and 5xx retries survive past lease expiry', async () => {
  const store = await withDatabase('lease-refused-other-claim');
  await store.init();
  try {
    const engine = new Engine(store, 1, 'owner/project');
    engine.principals = [operator, workerA, workerB];
    // Simulate a server downtime covering the lease expiry.
    const t0 = new Date(Date.now() - 120_000);
    await engine.recordPlaneLiveness(t0);

    let work = await engine.execute(operator, 'create', null, {
      title: 'Claimed by another session', type: 'bug',
      criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }],
    }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(workerA, 'claim', work.id, {}, randomUUID());
    const epochA = work.epoch;

    // Wait for lease to lapse, record a recovery stall whose 30s grace has already passed, then workerB claims the item.
    await delay(1_200);
    await engine.recordPlaneLiveness(new Date(Date.now() - 35_000));
    const claimedByB = await engine.execute(workerB, 'claim', work.id, {}, randomUUID());
    assert.equal(claimedByB.epoch, epochA + 1);
    assert.equal(claimedByB.lease?.owner, workerB.id);

    // Worker A's late renewal MUST be refused even though a plane stall occurred.
    await assert.rejects(
      engine.execute(workerA, 'heartbeat', work.id, { epoch: epochA }, randomUUID()),
      /Lease missing, expired, or superseded/,
      'renewal is refused when another session claimed the item',
    );
  } finally {
    await store.close();
  }

  // Also verify 5xx renewal failures keep the builder working past its local lease deadline.
  const dir = await temporaryDirectory('lease-5xx-retry');
  const marker = join(dir, 'done');
  let mode: 'ok' | '503' = 'ok';
  let recovered = false;
  const stub = createServer((req, res) => {
    if (mode === '503') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service unavailable during restart' }));
      return;
    }
    if (recovered) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + 1_000).toISOString() } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + 1_000).toISOString() } }));
  });
  await listen(stub);
  const url = `http://127.0.0.1:${portOf(stub)}`;
  try {
    let calls = 0;
    const supervising = supervise(
      process.execPath,
      ['-e', `const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0); }, 20);`],
      1,
      async () => {
        calls++;
        const result = await postJson(url, 'token', { epoch: 1 });
        if (calls > 1 && mode === 'ok') recovered = true;
        return result;
      },
      { intervalMs: 100, retryMs: 50, retryMaxMs: 100, safetyMarginMs: 200, graceMs: 50, session: {} },
    );
    await delay(150);
    mode = '503';
    // Stay in 503 well past the 1s lease deadline.
    await delay(1_500);
    mode = 'ok';
    for (const start = Date.now(); !recovered; await delay(30)) {
      if (Date.now() - start > 5_000) assert.fail('did not recover from 503');
    }
    await writeFile(marker, 'done');
    assert.equal(await supervising, 0, 'builder survived 503 past lease expiry and exited cleanly');
  } finally {
    await close(stub);
  }
});
