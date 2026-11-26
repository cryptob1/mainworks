import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { emptyDaemonState, daemonStateSchema } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { flowNumbers, type FlowItem } from '../src/flow-numbers.js';
import { trialAheadOfReviewReason } from '../src/model/merge-queue.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

const at = '2026-11-24T12:00:00Z';
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const proof = 'manual:docs-signoff';
const acceptanceRefusal = (p = proof) => `AC-1: ${p} needs trusted passing evidence, with skipped = 0, for this candidate and policy`;

function signoffItem(overrides: Partial<Work> = {}): Work {
  const candidate = { pr: 1, sha: head, baseSha: base };
  return workFixture({
    id: 'work-signoff', key: 'GY-42', title: 'Finished change awaiting sign-off', type: 'bug', priority: 1,
    criteria: [{ id: 'AC-1', text: 'Lead verifies the docs', proofs: [proof] }], producerProofs: [],
    stage: 'acceptance', revision: 5, createdAt: at, updatedAt: at, stageEnteredAt: at, epoch: 1,
    submission: { epoch: 1, pr: 1, sha: head } as never, candidate: candidate as never,
    observation: { at, source: 'control-plane', candidate, prState: 'open', draft: false, mergeable: true, protected: true, checks: [], reviews: [] } as never,
    mergeLedger: {
      key: 'GY-42',
      state: 'refused',
      head,
      baseTip: base,
      mergeSha: 'c'.repeat(40),
      risk: 'normal',
      intentAt: at,
      pushedAt: null,
      observedTip: null,
      refusal: { kind: 'merge', reason: trialAheadOfReviewReason('GY-42', [acceptanceRefusal()]) },
      trial: { head, mergeSha: 'c'.repeat(40), proofs: {} },
      events: 3,
    },
    gates: [
      { name: 'ready', passed: true, reasons: [] },
      { name: 'build', passed: true, reasons: [] },
      { name: 'review', passed: true, reasons: [] },
      { name: 'test', passed: true, reasons: [] },
      { name: 'acceptance', passed: false, reasons: [acceptanceRefusal()] },
      { name: 'merge', passed: false, reasons: [`merge writer has not pushed ${head.slice(0, 12)}`] },
    ],
    autoDispatch: { review: null, producers: [], history: [] },
    ...overrides,
  });
}

async function fixture(initialWork: Work[]) {
  const directory = await temporaryDirectory('manual-proof-wake');
  const config = masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard',
    hostId: 'test-host',
    baseBranch: 'main',
    githubAppId: 1234,
    masterAgentName: 'master',
    workers: [],
    run: { masterHeartbeatMinutes: 240 },
  });
  const prompts: string[] = [];
  let work = initialWork;
  let now = Date.parse(at);
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'idle' }],
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => {},
    persist: async () => {},
    masterSession: {
      wake: async (target, text) => {
        assert.equal(target, 'pM');
        prompts.push(text);
      },
      launch: async () => ({ agentName: 'master', pane: 'pM', runtime: 'codex', account: 'account', session: 'registered-master' }),
    },
  };
  let state = emptyDaemonState(config);
  return {
    directory,
    config,
    prompts,
    get state() { return state; },
    work: (next: Work[]) => { work = next; },
    restart: () => { state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state))); },
    advance: (minutes: number) => { now += minutes * 60_000; },
    now: () => now,
    cycle: () => runCycle(config, state, effects, () => now),
  };
}

test('unit:manual-proof-wait-wakes-the-lead — first wake by 5 minutes, repeat at 35, none once attested', async () => {
  const f = await fixture([signoffItem()]);
  // First wake by 5 minutes (advancing 5 min from stageEnteredAt).
  f.advance(5);
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'first wake fires by 5 minutes');
  assert.ok(f.prompts[0].includes('GY-42'), 'wake names item key');
  assert.ok(f.prompts[0].includes(proof), 'wake names manual proof');
  assert.ok(f.prompts[0].includes(head.slice(0, 12)), 'wake names candidate head');
  assert.equal(f.state.master.lastWake?.heartbeat, false);

  // Repeated cycles before 30 minutes elapsed do not re-wake, even across a restart.
  f.advance(10);
  await f.cycle();
  f.restart();
  f.advance(19);
  await f.cycle();
  assert.equal(f.prompts.length, 1, 'no repeat before 30 minutes after first wake');

  // Repeat at 35 minutes (30 minutes after the first wake at minute 5).
  f.advance(1);
  await f.cycle();
  assert.equal(f.prompts.length, 2, 'repeats every 30 minutes while unchanged (at minute 35)');
  assert.ok(f.prompts[1].includes('GY-42'));
  assert.ok(f.prompts[1].includes(proof));
  assert.ok(f.prompts[1].includes(head.slice(0, 12)));
  assert.equal(f.state.master.lastWake?.heartbeat, false);

  // Once attested, no further sign-off wakes fire even after another 35 minutes.
  const attested = signoffItem({
    stage: 'merge',
    stageEnteredAt: new Date(f.now()).toISOString(),
    updatedAt: new Date(f.now()).toISOString(),
    evidence: [{
      id: 'ev-1',
      proof,
      result: 'pass',
      executed: 1,
      skipped: 0,
      sha: head,
      baseSha: base,
      policyRevision: 1,
      trusted: true,
      producer: 'operator-agent',
      at: new Date(f.now()).toISOString(),
    }] as Work['evidence'],
    gates: signoffItem().gates.map(gate => gate.name === 'acceptance' ? { ...gate, passed: true, reasons: [] } : gate),
  });
  f.work([attested]);
  f.advance(35);
  await f.cycle();
  assert.equal(f.prompts.length, 2, 'no wake once attested');
  assert.deepEqual(f.state.master.subjects, {});
  assert.deepEqual(f.state.master.subjectWakes, {});
});

test('unit:manual-proof-wait-wakes-the-lead — none for a producer-owned proof or an item waiting on a reviewer', async () => {
  // Producer-owned manual proof (listed in producerProofs).
  const producerManual = signoffItem({ producerProofs: [proof] });
  const f1 = await fixture([producerManual]);
  f1.advance(5);
  await f1.cycle();
  f1.advance(35);
  await f1.cycle();
  assert.equal(f1.prompts.length, 0, 'no wake for a producer-owned manual proof');

  // Waiting on a producer for a unit/e2e proof.
  const unitProof = 'unit:some-check';
  const producerUnit = signoffItem({
    criteria: [{ id: 'AC-1', text: 'Unit test', proofs: [unitProof] }],
    gates: signoffItem().gates.map(gate => gate.name === 'acceptance'
      ? { ...gate, passed: false, reasons: [acceptanceRefusal(unitProof)] }
      : gate),
  });
  const f2 = await fixture([producerUnit]);
  f2.advance(5);
  await f2.cycle();
  assert.equal(f2.prompts.length, 0, 'no wake for a unit/producer proof');

  // Waiting on a reviewer (review gate not passed).
  const awaitingReview = signoffItem({
    stage: 'review',
    gates: signoffItem().gates.map(gate => gate.name === 'review'
      ? { ...gate, passed: false, reasons: ['Independent approval of the current commit is required'] }
      : gate),
  });
  const f3 = await fixture([awaitingReview]);
  f3.advance(5);
  await f3.cycle();
  assert.equal(f3.prompts.length, 0, 'no wake when waiting on a reviewer');
});

test('unit:manual-proof-wait-wakes-the-lead — master status lists sign-off wait at the top of attention', async () => {
  const directory = await temporaryDirectory('manual-proof-status');
  const root = await temporaryDirectory('manual-proof-status-root');
  execFileSync('git', ['init', '-q', root]);
  const config = masterConfigSchema.parse({
    version: 1,
    url: 'https://graphyard.example',
    repository: 'owner/project',
    credentialFile: join(directory, 'coordinator.token'),
    cliPath: '/bin/graphyard',
    hostId: 'test-host',
    baseBranch: 'main',
    githubAppId: 1234,
    masterAgentName: 'master',
    workers: [],
  });
  const nowIso = new Date(Date.parse(at) + 12 * 60_000).toISOString();
  const blockedOther = signoffItem({
    id: 'work-blocked',
    key: 'GY-99',
    stage: 'build',
    blocker: 'needs dependency fix',
    gates: signoffItem().gates.map(gate => gate.name === 'ready' ? { ...gate, passed: false, reasons: ['needs dependency fix'] } : gate),
  });
  const report = await masterStatusReport(
    root,
    config,
    async path => path === 'work-snapshot' ? { work: [blockedOther, signoffItem()], now: nowIso } : {},
    async (command, args) => isHerdrCommand(command) ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [] }) : '') : `${base}\n`,
  );
  assert.ok(report.attention.length >= 2);
  assert.equal(report.attention[0].subject, 'GY-42');
  assert.equal(report.attention[0].text, `waits for your sign-off: ${proof} on ${head.slice(0, 12)}, 12 min`);
});

test('unit:manual-proof-wait-wakes-the-lead — flow numbers split acceptance wait into waiting for sign-off and waiting for the merge writer', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const stage = (s: string, minutes: number) => ({ kind: 'submit', at: ago(minutes), stage: s });
  const signoffWaitItem: FlowItem = {
    key: 'GY-10',
    title: 'Waited for sign-off',
    stage: 'done',
    stageEnteredAt: ago(10),
    mergedAt: ago(10),
    attempts: [{ claimedAt: ago(120), endedAt: ago(90), end: 'submitted' }],
    events: [
      stage('acceptance', 60),
      { kind: 'merge.refused', at: ago(55), head, reason: trialAheadOfReviewReason('GY-10', [acceptanceRefusal()]) },
      stage('merge', 15),
      stage('done', 10),
    ],
  };
  const writerWaitItem: FlowItem = {
    key: 'GY-11',
    title: 'Waited for merge writer',
    stage: 'done',
    stageEnteredAt: ago(5),
    mergedAt: ago(5),
    attempts: [{ claimedAt: ago(80), endedAt: ago(50), end: 'submitted' }],
    events: [stage('acceptance', 20), stage('merge', 10), stage('done', 5)],
  };
  const flow = flowNumbers([signoffWaitItem, writerWaitItem], 6, now);
  assert.deepEqual(flow.stations['waiting for sign-off'], {
    median: 40,
    p90: 40,
    samples: 1,
    oldest: { key: 'GY-10', title: 'Waited for sign-off', minutes: 40, waiting: false },
  });
  assert.deepEqual(flow.stations['waiting for the merge writer'], {
    median: 5,
    p90: 10,
    samples: 2,
    oldest: { key: 'GY-11', title: 'Waited for merge writer', minutes: 10, waiting: false },
  });
  assert.equal(flow.stations.acceptance?.samples, 2);
});
