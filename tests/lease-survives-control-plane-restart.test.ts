import { listen } from './helpers/http-server.js';
// GY-3785 AC-1: a builder session whose lease renewal fails with a connection error or 5xx keeps
// working and retries for up to 5 minutes; the server accepts a renewal for a lease that lapsed
// while it was not serving, provided the item's epoch is unchanged and no other session claimed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
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

test('unit:lease-survives-control-plane-restart — stops a stub server past lease expiry mid-session and asserts the session ends submitted on the same epoch', { timeout: 60_000 }, async () => {
  const { root: dir, git } = await gitRepo({ label: 'lease-survives-restart', files: {} });
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('commit', '--allow-empty', '--quiet', '-m', 'builder work');
  const head = git('rev-parse', 'HEAD');
  const submitMarker = join(dir, 'submit-now');
  const submittedMarker = join(dir, 'submitted');
  const store = await withDatabase('lease-survives-restart');
  await store.init();

  let engine = new Engine(store, 2, 'owner/project');
  engine.principals = [operator, workerA, workerB];
  engine.gitRunner = gitRunnerFor(dir);
  let stopBeat = await engine.startPlaneBeat(500);
  let http: Server | undefined = server(engine, [operator, workerA, workerB]);
  let { port, close } = await listen(http);
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
      { intervalMs: 500, retryMs: 200, retryMaxMs: 500, graceMs: 200, session: {} },
    );
    void supervising.then(() => { settled = true; }, () => { settled = true; });

    // Wait for initial renewal so the builder is running mid-session.
    for (const start = Date.now(); renewals < 1 && !settled; await delay(50)) {
      if (Date.now() - start > 10_000) assert.fail('initial renewal never landed');
    }
    assert.equal(settled, false, 'builder is running before downtime');

    // Stop the stub server for 6 seconds mid-session (3x the 2s lease, well past expiry).
    stopBeat();
    await close();
    http = undefined;
    await delay(6_000);
    assert.equal(settled, false, 'builder kept working through server downtime past lease expiry');

    // Restart the server on the same port with a fresh Engine against the same Store.
    engine = new Engine(store, 2, 'owner/project');
    engine.principals = [operator, workerA, workerB];
    engine.gitRunner = gitRunnerFor(dir);
    stopBeat = await engine.startPlaneBeat(500);
    http = server(engine, [operator, workerA, workerB]);
    ({ close } = await listen(http, port));

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
    if (http) await close();
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
  const { url, close } = await listen((req, res) => {
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
    await close();
  }
});

// GY-3905 AC-2: a rework attempt's lease is restored after a restart longer than the lease; an item
// on hold, not ready, claimed under another epoch or submitted under this epoch is refused as before.
async function restartFixture(label: string) {
  const store = await withDatabase(label);
  await store.init();
  const engine = new Engine(store, 60, 'owner/project');
  engine.principals = [operator, workerA, workerB];
  const head = 'c'.repeat(40);
  engine.gitRunner = async args => ({ status: 0, stdout: args[0] === 'diff' ? '' : head, stderr: '' });
  const ready = async (title: string) => {
    const work = await engine.execute(operator, 'create', null, { title, type: 'bug', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }] }, randomUUID());
    return engine.execute(operator, 'ready', work.id, {}, randomUUID());
  };
  const claim = async (id: string, actor: Principal = workerA) => {
    const work = await engine.execute(actor, 'claim', id, {}, randomUUID());
    // A rework attempt builds on the pull request branch its earlier attempt submitted.
    const branch = work.submission ? work.workspaces[0].branch : `graphyard/${work.key.toLowerCase()}-${work.epoch}`;
    return engine.execute(actor, 'workspace', work.id, { epoch: work.epoch, host: 'restart-host', path: `/tmp/restart/${work.id}-${work.epoch}`, branch }, randomUUID());
  };
  const submit = (work: Work, actor: Principal = workerA) => engine.execute(actor, 'submit', work.id, { epoch: work.epoch, head }, randomUUID());
  const heartbeat = (work: Work, actor: Principal = workerA) => engine.execute(actor, 'heartbeat', work.id, { epoch: work.epoch }, randomUUID());
  return { store, engine, ready, claim, submit, heartbeat };
}

// GY-3956: the outage is laid on the database's clock, the one that stamps every lease, and the leases are
// lapsed by moving their expiry, not by sleeping. Before, the stall's end came from this process's clock after a
// 2.5 s sleep on a 1 s lease, so the restore window held by 0.5 s and a database clock that far ahead refused it.
async function reworkRestoresAfterRestart(label: string) {
  const { store, engine, ready, claim, submit, heartbeat } = await restartFixture(label);
  try {
    // A rework attempt: the first attempt submitted, the master asked for rework, a builder claimed again.
    let rework = await claim((await ready('Rework survives restart')).id);
    await submit(rework);
    await engine.execute(operator, 'rework', rework.id, { reason: 'Fix the review finding', previousWorkerStopped: true }, randomUUID());
    rework = await claim(rework.id);
    assert.equal(rework.epoch, 2);
    assert.equal(rework.submission?.epoch, 1, 'the rework attempt still carries the earlier submission');
    const held = await claim((await ready('Held during restart')).id);
    const unready = await claim((await ready('Not ready after restart')).id);
    const taken = await claim((await ready('Claimed under another epoch')).id);
    const submitted = await claim((await ready('Submitted under this epoch')).id);
    await submit(submitted);

    // The plane was down from 120 s to 31 s ago and every lease ran out 2 s ago, inside the 30 s a stall
    // leaves for renewals; that grace has passed, so only the downtime restore can keep a lease.
    const now = ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).getTime();
    await engine.recordPlaneLiveness(new Date(now - 120_000));
    await engine.recordPlaneLiveness(new Date(now - 31_000));
    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{lease,expiresAt}', to_jsonb($1::text)) WHERE jsonb_typeof(document->'lease') = 'object'`, [new Date(now - 2_000).toISOString()]);

    const restored = await heartbeat(rework);
    assert.equal(restored.lease?.owner, workerA.id, 'the rework lease is restored');
    assert.equal(restored.lease?.epoch, 2);
    const done = await submit(rework);
    assert.equal(done.submission?.epoch, 2, 'the rework builder submits on the same epoch');

    await engine.execute(operator, 'hold', held.id, { reason: 'Owner paused it' }, randomUUID());
    await assert.rejects(heartbeat(held), /Lease missing, expired, or superseded/, 'a held item is not restored');

    await store.pool.query(`UPDATE work_items SET document = jsonb_set(document, '{ready}', 'false') WHERE id=$1`, [unready.id]);
    await assert.rejects(heartbeat(unready), /Lease missing, expired, or superseded/, 'an item that is not ready is not restored');

    const rival = await claim(taken.id, workerB);
    assert.equal(rival.epoch, taken.epoch + 1);
    await assert.rejects(heartbeat(taken), /Lease missing, expired, or superseded/, 'an item claimed under another epoch is not restored');

    await assert.rejects(heartbeat(submitted), /ended when .* was submitted/, 'an epoch already submitted is not restored');
  } finally {
    await store.close();
  }
}

test('integration:rework-lease-restores-after-restart — a rework builder keeps its attempt across a restart longer than the lease; hold, not ready, another epoch and a submitted epoch are refused', { timeout: 60_000 }, () => reworkRestoresAfterRestart('rework-lease-restores'));

// GY-3956 seam: this process's clock runs 1 s behind the database's, the condition that refused the restore.
test('unit:lease-survives-control-plane-restart-pinned — the rework lease is restored when this process clock runs 1 s behind the database clock that stamps leases', { timeout: 60_000 }, async () => {
  const realNow = Date.now;
  Date.now = () => realNow() - 1_000;
  try { await reworkRestoresAfterRestart('rework-lease-pinned'); } finally { Date.now = realNow; }
});

test('integration:released-epoch-is-never-reused — a release, with or without a workspace failure, ends the attempt; the next claim takes a new number and the released epoch is refused', async () => {
  const { store, engine, ready, claim, heartbeat } = await restartFixture('released-epoch-never-reused');
  try {
    for (const failure of [{ message: 'Git worktree creation failed: fatal: branch is already used by worktree' }, undefined]) {
      const first = await claim((await ready(`Released ${failure ? 'after a workspace failure' : 'plainly'}`)).id);
      const released = await engine.execute(workerA, 'release', first.id, { epoch: first.epoch, ...(failure ? { failure } : {}) }, randomUUID());
      assert.equal(released.epoch, first.epoch, 'the release never lowers the epoch');
      assert.equal(released.lease, null);
      assert.equal(released.pipeline?.attempts.at(-1)?.end, 'released', 'the release ends the attempt');
      const next = await claim(first.id);
      assert.equal(next.epoch, first.epoch + 1, 'the next claim takes a new number');
      await assert.rejects(heartbeat(first), /Lease missing, expired, or superseded/, 'a heartbeat under the released epoch is refused');
      await assert.rejects(engine.execute(workerA, 'release', first.id, { epoch: first.epoch }, randomUUID()), /Lease missing, expired, or superseded/, 'a release under the released epoch is refused');
      assert.equal((await heartbeat(next)).lease?.epoch, next.epoch, 'the new attempt holds its own lease');
    }
  } finally {
    await store.close();
  }
});
