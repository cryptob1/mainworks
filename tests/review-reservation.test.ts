import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { loopStateClient, loopStateContext, type LoopStateClient } from '../src/loop-state.js';
import { launchReview, readReviewLedger, reconcileReviews, saveReviewLedger, saveReviewerProfile, type ReviewRecord } from '../src/reviewer.js';
import type { HeadlessExec } from '../src/headless-session.js';
import type { Work } from '../src/model.js';
import { clearRuns } from '../src/runner/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3990: a review is reserved by one conditional insert on the control plane (the head-and-kind
// slot row), not a host lock file whose stale-break let a second launcher take a held reservation.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha = (label: string) => label.padEnd(40, 'f');
const B = sha('b1');
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const registerLaunch = async () => ({ launch: 'fixture-launch' });

async function boundMaster() {
  const root = await temporaryDirectory('reservation'), credentialDirectory = await temporaryDirectory('reservation-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory, herdrWorkspace: 'wE' }, coordinatorStatus as typeof fetch);
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude', kind: 'claude', concurrency: 10 });
  return { root, cleanup: async () => { clearRuns(); await rm(root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}
function work(key: string, head: string): Work {
  const candidate = { sha: head, baseSha: B, pr: 64, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return workFixture({ id: `work-${key}`, key, title: 'Frobs', priority: 0,
    criteria: [{ id: 'AC-1', text: 'The widget counts every frob.', proofs: ['unit:frob-count'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 7, epoch: 1, candidate, submission: { epoch: 1, pr: 64 }, gates: [],
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(),
      prState: 'open', draft: false, baseTip: B, baseTree: B, baseTipContained: true } as never });
}
/** Every runtime the launches start, by item and head; each one stays in flight. */
function runtimes() {
  const started: string[] = [];
  const headless: HeadlessExec = (_command, _args, options) => { started.push(options.run); return new Promise(() => {}); };
  return { started, headless };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const pendingFor = (reviews: ReviewRecord[], key: string, head: string) => reviews.filter(record => record.state === 'pending' && record.key === key && record.sha === head);

test('integration:one-reviewer-reservation-per-head-and-kind — ten launchers reserve one review; a held read neither loses its reservation nor drops another head; kinds reserve independently; a stale save reapplies only its own fields', async () => {
  const { root, cleanup } = await boundMaster();
  const probe = registryFixture(hostname(), ['claude'], ['reviewer'], 20).probe;
  try {
    // Ten launchers reserve the same head and kind at once: exactly one record, one session.
    const H1 = sha('a1'), ten = runtimes();
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => launchReview(root, work('GY-64', H1), 'claude-reviewer', [], new Date().toISOString(), { headless: ten.headless, registerLaunch, probe })));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1, JSON.stringify(outcomes.map(outcome => outcome.status === 'rejected' ? String(outcome.reason).slice(0, 200) : 'launched')));
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.match(String(outcome.reason), /already (being launched|pending|reserved)/);
    assert.equal(ten.started.length, 1, 'one session launch');
    assert.equal(pendingFor((await readReviewLedger(root)).reviews, 'GY-64', H1).length, 1, 'one reservation');

    // A launcher whose control-plane read is held for 90 s keeps its reservation; a second
    // launcher arriving 90 s later neither takes it nor loses its own reservation for another head.
    const H2 = sha('a2'), H3 = sha('a3'), held = runtimes(), second = runtimes();
    const holding = deferred(), release = deferred();
    const outer = loopStateContext.getStore()!;
    let reserved = false, waited = false;
    const first = loopStateContext.run(scope => {
      const client = outer(scope);
      return {
        read: async kind => { if (reserved && !waited) { waited = true; holding.resolve(); await release.promise; } return client.read(kind); },
        write: async (kind, records, removed, migrate) => { await client.write(kind, records, removed, migrate); if (kind === 'reviews' && records.some(record => record.sha === H2)) reserved = true; },
      } satisfies LoopStateClient;
    }, () => launchReview(root, work('GY-65', H2), 'claude-reviewer', [], new Date().toISOString(), { headless: held.headless, registerLaunch, probe }));
    await holding.promise;
    const later = () => new Date(Date.now() + 90_000);
    await assert.rejects(launchReview(root, work('GY-65', H2), 'claude-reviewer', [], later().toISOString(), { now: later, headless: second.headless, registerLaunch, probe }), /already being launched/);
    const own = await launchReview(root, work('GY-66', H3), 'claude-reviewer', [], later().toISOString(), { now: later, headless: second.headless, registerLaunch, probe });
    release.resolve();
    const launched = await first;
    const ledger = (await readReviewLedger(root)).reviews;
    assert.deepEqual(pendingFor(ledger, 'GY-65', H2).map(record => record.id), [launched.review], 'the held launcher keeps its reservation');
    assert.deepEqual(pendingFor(ledger, 'GY-66', H3).map(record => record.id), [own.review], 'the second launcher keeps its own for another head');
    assert.deepEqual([held.started.length, second.started.length], [1, 1]);

    // Code review, product review and post-merge review of one head reserve independently; a second code review does not.
    const client = await loopStateClient(root), H4 = sha('a4');
    const base = { ...ledger.find(record => record.id === own.review)!, key: 'GY-67', sha: H4 };
    delete base.revision;
    await client.write('reviews', [{ ...base, id: randomUUID() }, { ...base, id: randomUUID(), product: true }, { ...base, id: randomUUID(), postMerge: true }]);
    await assert.rejects(client.write('reviews', [{ ...base, id: randomUUID() }]), /already reserved/);
    assert.equal(pendingFor((await readReviewLedger(root)).reviews, 'GY-67', H4).length, 3);

    // Two saves from the same read: the later one meets a revision conflict, re-reads, and reapplies only its own field.
    const [one, two] = [await readReviewLedger(root), await readReviewLedger(root)];
    one.reviews.find(record => record.id === own.review)!.idleSince = '2026-11-27T10:00:00.000Z';
    two.reviews.find(record => record.id === own.review)!.acknowledgedAt = '2026-11-27T10:01:00.000Z';
    await saveReviewLedger(root, one);
    await saveReviewLedger(root, two);
    const merged = (await readReviewLedger(root)).reviews.find(record => record.id === own.review)!;
    assert.equal(merged.idleSince, '2026-11-27T10:00:00.000Z', 'the earlier save is kept');
    assert.equal(merged.acknowledgedAt, '2026-11-27T10:01:00.000Z', 'the later change is applied');
  } finally { await cleanup(); }
});

test('unit:ledger-rows-from-the-old-lock-still-settle — rows the lock-era code wrote, duplicates included, settle with the new code; its leftover lock file is ignored and removed', async () => {
  const { root, cleanup } = await boundMaster();
  const dataHome = await temporaryDirectory('reservation-data'), was = process.env.GRAPHYARD_DATA_HOME;
  process.env.GRAPHYARD_DATA_HOME = dataHome;
  try {
    const lock = resolve(dataHome, 'review-ledger', `${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12)}.lock`);
    await mkdir(join(dataHome, 'review-ledger'), { recursive: true });
    await writeFile(lock, `${process.pid} ${Date.now()}`);
    // Exactly what the lock-era launcher wrote: no revision, no reservation row; a race it lost left two pending records of one head and kind.
    const H = sha('c1'), requestedAt = new Date(Date.now() - 60_000).toISOString();
    const row = (id: string, agentName: string) => ({ id, key: 'GY-64', pr: 64, sha: H, baseSha: B, policyRevision: 1, profile: 'claude-reviewer', agentName, pane: null,
      sessionDirectory: join(root, 'sessions', id), requestedAt, tokenExpiresAt: new Date(Date.now() + 3_000_000).toISOString(), state: 'pending', delivery: 'request',
      acknowledgedAt: requestedAt, criteriaOnly: true, mode: 'control-plane', verdictTokenHash: 'a'.repeat(64), launch: `launch-${agentName}`,
      reviewInputs: { criteria: [], scenarioRequirements: [] }, reviewRound: { changesRequested: 0 } });
    const ids = [randomUUID(), randomUUID()];
    await (await loopStateClient(root)).write('reviews', [row(ids[0]!, 'review-claude-1'), row(ids[1]!, 'review-claude-2')], [], true);
    const config = await loadMasterConfig(root);
    const settled = await reconcileReviews(root, config, { observe: record => ({ state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: record.agentName.endsWith('1') ? 77 : 78, submittedAt: new Date().toISOString() }) });
    assert.equal(settled.changed > 0, true);
    const reviews = (await readReviewLedger(root)).reviews;
    assert.deepEqual(ids.map(id => reviews.find(record => record.id === id)?.state), ['completed', 'completed']);
    assert.deepEqual(ids.map(id => reviews.find(record => record.id === id)?.verdict?.state), ['APPROVED', 'APPROVED']);
    assert.equal(existsSync(lock), false, 'the old lock file is removed');
    // The settled head is free again: a new launch reserves it.
    const fresh = runtimes();
    await launchReview(root, work('GY-64', H), 'claude-reviewer', [], new Date().toISOString(), { headless: fresh.headless, registerLaunch, probe: registryFixture(hostname(), ['claude'], ['reviewer']).probe });
    assert.equal(fresh.started.length, 1);
  } finally {
    if (was === undefined) delete process.env.GRAPHYARD_DATA_HOME; else process.env.GRAPHYARD_DATA_HOME = was;
    await cleanup(); await rm(dataHome, { recursive: true, force: true });
  }
});
