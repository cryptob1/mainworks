import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { reconcileActions } from '../src/model-boundary/actions.js';
import { productReviewRefusal } from '../src/model-boundary/product-review.js';
import { loadMasterConfig, selectAccount, setupMaster } from '../src/master.js';
import { saveReviewerProfile } from '../src/reviewer.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { workFixture } from './helpers/work-fixture.js';
import { observationFixture } from './helpers/observation-fixture.js';

// GY-3684 AC-2: when several heads owe a product review, launches go oldest request first.
// Seeds one head owing a product review for a day and three fresh ones while main moves every
// cycle, with a stub reviewer, and asserts the old head is launched first and merges without a
// second product review.

const shaOf = (seed: string) => createHash('sha1').update(seed).digest('hex');

const M0 = shaOf('main-0');
const M1 = shaOf('main-1');
const M2 = shaOf('main-2');
const M3 = shaOf('main-3');

function featureItem(key: string, head: string, base: string, requestedAt: Date): Work {
  const at = requestedAt.toISOString();
  const candidate = { sha: head, baseSha: base, pr: 1, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker-1' };
  const work = workFixture({
    id: randomUUID(), key, title: `Feature ${key}`, priority: 1, criteria: [{ id: 'AC-1', text: 'Works end to end', proofs: ['e2e:smoke'] }], stage: 'review', revision: 3,
    createdAt: at, updatedAt: at, stageEnteredAt: at, epoch: 1, workspaces: [{ host: 'h', path: `/w/${key}`, branch: candidate.branch, epoch: 1, owner: 'worker-1' }],
    candidate, submission: { epoch: 1, pr: 1 },
    evidence: [{ id: `ev-${key}`, proof: 'e2e:smoke', sha: head, baseSha: base, policyRevision: 1, producer: 'merge-trial', trusted: true, result: 'pass', executed: 1, skipped: 0, at }],
    gates: [], implementers: ['worker-1'],
    observation: observationFixture(candidate, { source: 'control-plane', at, reviews: [{ id: 1, reviewer: 'code-reviewer', state: 'APPROVED', sha: head, submittedAt: at }],
      protected: false, files: ['web/feature.ts'], mergeBase: base,
      scopeFiles: [{ path: 'web/feature.ts', status: 'added', sha: shaOf(`${key}-file`), additions: 10, deletions: 0, binary: false }] }),
    productReview: null,
  });
  work.gates = evaluate(work, [work], requestedAt).gates;
  reconcileAutoDispatch(work, [work], requestedAt);
  reconcileActions(work, [work], requestedAt);
  return work;
}

function advanceMain(items: Work[], newBase: string, at: Date) {
  const iso = at.toISOString();
  for (const item of items) {
    if (item.stage === 'done') continue;
    item.candidate = { ...item.candidate!, baseSha: newBase };
    item.observation = {
      ...item.observation!,
      at: iso,
      candidate: { ...item.observation!.candidate, baseSha: newBase },
      baseTip: newBase,
      baseTipContained: false,
      mergeable: true,
    };
    item.evidence = item.evidence.map(e => ({ ...e, baseSha: newBase }));
    const judged = evaluate(item, items, at);
    item.gates = judged.gates;
    item.stage = judged.stage;
    reconcileAutoDispatch(item, items, at);
    reconcileActions(item, items, at);
  }
}

test('e2e:old-review-is-not-starved — old head owing a product review is launched first and merges without a second product review while main moves every cycle', async () => {
  const host = await temporaryDirectory('old-review-not-starved-host');
  const credentialDirectory = await temporaryDirectory('old-review-not-starved-creds');
  try {
    execFileSync('git', ['init', '-q', host]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: host });
    const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(host, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: '/bin/true', credentialDirectory, herdrWorkspace: 'wP' }, status as typeof fetch);
    await saveReviewerProfile(host, { name: 'product-reviewer', agentName: 'product-reviewer', kind: 'claude' });
    const config = await loadMasterConfig(host);

    const now = new Date('2026-11-22T12:00:00.000Z');
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
    const oldHead = shaOf('old-head');
    const oldItem = featureItem('GY-9001', oldHead, M0, dayAgo);
    const fresh1 = featureItem('GY-9002', shaOf('fresh-1'), M0, new Date(now.getTime() - 3 * 60_000));
    const fresh2 = featureItem('GY-9003', shaOf('fresh-2'), M0, new Date(now.getTime() - 2 * 60_000));
    const fresh3 = featureItem('GY-9004', shaOf('fresh-3'), M0, new Date(now.getTime() - 1 * 60_000));

    // Snapshot lists the three fresh items ahead of the day-old item.
    const items = [fresh1, fresh2, fresh3, oldItem];
    const oldInitialActionRowId = oldItem.actionQueue!.actions[0]!.id;
    const oldInitialActionRequestedAt = oldItem.actionQueue!.actions[0]!.requestedAt;

    // Cycle 1: main moves to M1 before dispatch.
    const cycle1At = new Date(now.getTime() + 1 * 60_000);
    advanceMain(items, M1, cycle1At);

    // Main moving must not reset the old head's request-review action or product dispatch timestamp.
    assert.equal(oldItem.actionQueue!.actions[0]!.id, oldInitialActionRowId, 'old head action row id survives main move');
    assert.equal(oldItem.actionQueue!.actions[0]!.requestedAt, oldInitialActionRequestedAt, 'old head action requestedAt stays a day old');
    assert.equal(oldItem.autoDispatch!.product!.requestedAt, dayAgo.toISOString(), 'old head product request stays a day old');

    // One reviewer slot: only the first-launched head can take the slot this cycle.
    const fleet = registryFixture(config.hostId, ['claude'], ['reviewer'], 1);
    let currentClock = cycle1At;
    const launchedKeys: string[] = [];
    const inFlight: { work: Work; sha: string; baseSha: string }[] = [];

    const effects = {
      snapshot: async () => ({ work: items, now: currentClock.toISOString() }),
      agents: () => [],
      credentials: async () => ({}),
      reconcileReviews: async () => ({ reviews: [] }),
      reconcileProducers: async () => ({ producers: [] }),
      launchReview: async () => { throw new Error('code reviews are already approved'); },
      launchProducer: async () => { throw new Error('no producer is needed'); },
      launchProductReview: async (work: Work, request: { sha: string; baseSha: string }, profile: { name: string }) => {
        await selectAccount(config, 'reviewer', profile, { ...fleet.probe, work: work.key });
        launchedKeys.push(work.key);
        inFlight.push({ work, sha: request.sha, baseSha: request.baseSha });
        return { agentName: `product-reviewer-${launchedKeys.length}`, pane: null };
      },
      persist: async () => {},
    };

    const tick1 = await runDispatchTick(config, emptyDispatchCursor(config), effects as never, () => currentClock.getTime());
    assert.equal(launchedKeys[0], 'GY-9001', `expected oldest request GY-9001 to launch first, got ${launchedKeys.join(', ')}`);
    assert.equal(tick1.launched[0]?.work, 'GY-9001');

    // Main moves to M2 while GY-9001's product review is in flight.
    const cycle2At = new Date(now.getTime() + 10 * 60_000);
    currentClock = cycle2At;
    advanceMain(items, M2, cycle2At);

    // Stub reviewer finishes and posts approval for the head it judged (oldHead).
    const first = inFlight.shift()!;
    assert.equal(first.work.key, 'GY-9001');
    first.work.productReview = {
      sha: first.sha,
      baseSha: first.baseSha,
      verdict: 'approved',
      reviewer: 'product-reviewer',
      findings: 'Old head looks good.',
      screenshots: [],
      at: cycle2At.toISOString(),
    };
    // Release the reviewer slot now that the stub review ended.
    for (const session of fleet.sessions().filter(s => !s.endedAt)) await fleet.client.end(session.id, 'stub review finished');

    // Cycle 3: main moves again to M3 before GY-9001 merges.
    const cycle3At = new Date(now.getTime() + 20 * 60_000);
    currentClock = cycle3At;
    advanceMain(items, M3, cycle3At);

    // GY-9001's product approval still stands on M3 — no second product review is requested.
    assert.equal(productReviewRefusal(oldItem), null, 'GY-9001 product approval still satisfies the gate after main moved to M3');
    assert.equal(oldItem.gates.find(g => g.name === 'review')!.passed, true, 'GY-9001 review gate passes on M3');
    assert.equal(oldItem.autoDispatch?.product, null, 'no second product review request is opened for GY-9001');

    // Merge writer trials and pushes GY-9001 onto M3: every gate passes and it merges without a second product review.
    oldItem.mergeLedger = {
      head: oldHead,
      baseTip: M3,
      state: 'reconciled',
      pushedAt: cycle3At.toISOString(),
      trial: { head: oldHead, proofs: { 'e2e:smoke': { executed: 1, failed: 0 } } },
    } as never;
    const mergeJudged = evaluate(oldItem, items, cycle3At);
    assert.deepEqual(mergeJudged.gates.filter(g => !g.passed).map(g => g.name), [], 'GY-9001 passes every gate and merges');
    assert.equal(mergeJudged.stage, 'merge');
    oldItem.stage = 'done';

    // Next dispatch tick launches the next oldest fresh item (GY-9002), never GY-9001 again.
    await runDispatchTick(config, emptyDispatchCursor(config), effects as never, () => currentClock.getTime());
    assert.equal(launchedKeys.filter(key => key === 'GY-9001').length, 1, 'GY-9001 was product-reviewed exactly once');
    assert.equal(launchedKeys[1], 'GY-9002', 'next oldest fresh request GY-9002 launches next');
  } finally {
    await rm(host, { recursive: true, force: true });
    await rm(credentialDirectory, { recursive: true, force: true }).catch(() => {});
  }
});
