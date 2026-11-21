import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { evaluate } from '../src/model-boundary/gates.js';
import { nextAction } from '../src/model-boundary/next-action.js';
import type { Work } from '../src/model.js';
import { loadMasterConfig, selectAccount, setupMaster } from '../src/master.js';
import { saveReviewerProfile } from '../src/reviewer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { registryFixture } from './helpers/registry-fixture.js';

// GY-3608 AC-2: a head already approved by the code reviewer that still owes a product review
// never stalls on 'cannot be reviewed and no executor step answers it', and the next dispatch tick
// launches its product review when a reviewer account is free.

const H = '2a2f08e7a188'.padEnd(40, 'a'), B = 'b'.repeat(40);
const at = '2026-11-21T22:21:00.000Z';
const shaOf = (seed: string) => createHash('sha1').update(seed).digest('hex');

function codeApprovedFeature(key: string): Work {
  const candidate = { sha: H, baseSha: B, pr: 0, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker-1' };
  return {
    id: randomUUID(), key, title: `Feature ${key}`, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works end to end', proofs: ['e2e:smoke'] }],
    policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: `/w/${key}`, branch: candidate.branch, epoch: 1, owner: 'worker-1' }],
    candidate, submission: { epoch: 1, pr: 0 }, reworkRequested: false,
    scenarioRequirements: [],
    evidence: [{ id: 'e1', proof: 'e2e:smoke', sha: H, baseSha: B, policyRevision: 1, producer: 'merge-trial', trusted: true, result: 'pass', executed: 1, skipped: 0, at }],
    blocker: null, gates: [], violations: [], implementers: ['worker-1'],
    observation: {
      source: 'control-plane', at, candidate, checks: [],
      reviews: [{ id: 1, reviewer: 'review-codex', state: 'APPROVED', sha: H, submittedAt: at }],
      merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['web/feature.ts'],
      scopeFiles: [{ path: 'web/feature.ts', status: 'added' as const, sha: shaOf(key), additions: 10, deletions: 0, binary: false }],
      baseTip: B, baseTipContained: true, mergeBase: B,
    },
    productReview: null,
  } as unknown as Work;
}

test('unit:approved-head-gets-its-product-review — a code-approved head owing a product review asks for the product review and the next dispatch tick launches it', async () => {
  const host = await temporaryDirectory('approved-head-product-review');
  const credentialDirectory = await temporaryDirectory('approved-head-product-credentials');
  try {
    execFileSync('git', ['init', '-q', host]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: host });
    const status = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
    await setupMaster(host, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: '/bin/true', credentialDirectory, herdrWorkspace: 'wP' }, status as typeof fetch);
    await saveReviewerProfile(host, { name: 'product-reviewer', agentName: 'product-reviewer', kind: 'claude' });
    const config = await loadMasterConfig(host);

    const item = codeApprovedFeature('GY-3528');
    const now = new Date('2026-11-21T22:25:00.000Z');
    item.gates = evaluate(item, [item], now).gates;
    reconcileAutoDispatch(item, [item], now);

    assert.deepEqual(item.gates.find(gate => gate.name === 'review')?.reasons, ['Product review of the current commit is required']);
    assert.equal(item.autoDispatch?.review, null, 'code review is already satisfied');
    assert.equal(item.autoDispatch?.product?.state, 'requested', 'product review request is open');

    const action = nextAction(item, [item], now);
    assert.ok(action, 'item has a next action');
    assert.notEqual(action.kind, 'attention', 'must not stall on attention');
    assert.doesNotMatch(action.reason, /cannot be reviewed and no executor step answers it/);
    assert.equal(action.kind, 'request-review');
    assert.equal(action.inputs.kind, 'request-review');
    assert.equal(action.inputs.requestId, item.autoDispatch!.product!.id);

    const launches: { work: string; sha: string }[] = [];
    const fleet = registryFixture(config.hostId, ['claude'], ['reviewer']);
    const effects = {
      snapshot: async () => ({ work: [item], now: now.toISOString() }),
      agents: () => [],
      credentials: async () => ({}),
      reconcileReviews: async () => ({ reviews: [] }),
      reconcileProducers: async () => ({ producers: [] }),
      launchReview: async () => { throw new Error('code review is already approved'); },
      launchProducer: async () => { throw new Error('no producer is needed'); },
      launchProductReview: async (work: Work, request: { sha: string }, profile: { name: string }) => {
        await selectAccount(config, 'reviewer', profile, { ...fleet.probe, work: work.key });
        launches.push({ work: work.key, sha: request.sha });
        return { agentName: 'product-reviewer', pane: null };
      },
      persist: async () => {},
    };

    const tick = await runDispatchTick(config, emptyDispatchCursor(config), effects as never, () => now.getTime());
    assert.deepEqual(tick.launched.map(entry => [entry.work, entry.reason]), [['GY-3528', 'product review']]);
    assert.deepEqual(launches, [{ work: 'GY-3528', sha: H }]);
  } finally {
    await rm(host, { recursive: true, force: true });
    await rm(credentialDirectory, { recursive: true, force: true }).catch(() => {});
  }
});
