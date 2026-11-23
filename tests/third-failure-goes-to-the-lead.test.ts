import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import type { Principal } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import { daemonStatePath, emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { herdrSubcommand, isHerdrCommand } from '../src/master/herdr.js';
import { appliedReworkBrief, reworkBriefSection } from '../src/master/rework-brief.js';

const proof = 'e2e:third-failure-goes-to-the-lead';

test(`${proof} — three refusals of any cause (excluding base-moved conflicts) stop automatic launches, raise one Lead decision naming all three, and show in master status`, async () => {
  setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
  const store = await withDatabase('third-failure-goes-to-the-lead');
  await store.init();
  try {
  const engine = new Engine(store, 7200, 'owner/project');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;

  const master: Principal = { id: 'graphyard-master-project-operator', role: 'operator-agent', scope: { repositories: ['owner/project'], workItems: ['*'] } };
  const builder: Principal = { id: 'mainworks-stub-builder', role: 'worker' };

  let work = await engine.execute(master, 'create', null, {
    reason: 'fixture',
    title: 'Stub builder repeated rework item',
    type: 'feature',
    criteria: [{ id: 'AC-1', text: 'Works cleanly', proofs: ['e2e:third-failure-goes-to-the-lead'] }],
  }, randomUUID());
  work = await engine.execute(master, 'ready', work.id, { reason: 'fixture', expectedRevision: work.revision }, randomUUID());

  const dir = await temporaryDirectory('third-failure-lead');
  const worker: WorkerProfile = {
    name: 'stub-builder', principal: builder.id, agentName: 'builder-stub', mode: 'launch', kind: 'codex',
    credentialFile: join(dir, 'builder.token'), agentArgs: [], approvals: 'auto', environment: {},
  };
  const config = masterConfigSchema.parse({
    version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(dir, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    masterAgentName: 'master', workers: [worker], run: { masterHeartbeatMinutes: 240 },
  });

  let now = Date.now();
  const iso = () => new Date(now).toISOString();
  const launches: { epoch: number; brief: string }[] = [];
  const wakes: string[] = [];

  const reload = async () => (await store.list()).find(entry => entry.id === work.id)!;

  // Stub Builder: claims the item, records the rework brief it received, registers a workspace and submits a head.
  const effects: DaemonEffects = {
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'working' }],
    credentials: async () => ({ [worker.name]: { available: true, reason: null } }),
    snapshot: async () => ({ work: await store.list(), now: iso() }),
    closeSession: () => {},
    persist: async () => {},
    dispatch: async (item) => {
      const brief = reworkBriefSection(item, appliedReworkBrief(item));
      const claimed = await engine.execute(builder, 'claim', item.id, {}, randomUUID());
      await engine.execute(builder, 'workspace', item.id, { epoch: claimed.epoch, host: 'test-host', path: join(dir, `wt-${claimed.epoch}`), branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
      await engine.execute(builder, 'submit', item.id, { epoch: claimed.epoch, pr: 42 }, randomUUID());
      launches.push({ epoch: claimed.epoch, brief });
      return { epoch: claimed.epoch };
    },
    masterSession: {
      wake: async (_target, text) => { wakes.push(text); },
      launch: async () => assert.fail('master is visible'),
    },
  };

  const state = emptyDaemonState(config);
  const cycle = async () => { now += 60_000; await runCycle(config, state, effects, () => now); };

  // Round 1: stub Builder launches and submits -> refused by review (1st counted refusal).
  await cycle();
  assert.equal(launches.length, 1, `attempt 1 launches (actions=${JSON.stringify(state.actions)})`);
  const reason1 = `${work.key}: review-a requested changes on 111111111111: BLOCKING: missing validation on input`;
  await engine.execute(master, 'rework', work.id, { reason: reason1, previousWorkerStopped: true, binding: `${'1'.repeat(40)}:verdict:review-a` }, randomUUID());

  // Round 2: stub Builder launches -> refused by a base-moved conflict (must NOT count toward the 3).
  await cycle();
  assert.equal(launches.length, 2, `attempt 2 launches (actions=${JSON.stringify(state.actions)})`);
  assert.match(launches[1].brief, /Attempt 1 \(review\):.*missing validation on input/);
  const baseMovedReason = `${work.key}: GitHub reports conflict. The base moved: run sync ${work.key}, resolve, then complete ${work.key} EPOCH --head NEWSHA.`;
  await engine.execute(master, 'rework', work.id, { reason: baseMovedReason, previousWorkerStopped: true, binding: `${'2'.repeat(40)}:conflict` }, randomUUID());

  // Round 3: stub Builder launches -> refused by merge trial (2nd counted refusal).
  await cycle();
  assert.equal(launches.length, 3, 'attempt 3 launches (base-moved did not count)');
  const reason2 = `${work.key}: the merge writer's trial of candidate 333333333333 failed: trial failed: tests/alpha.test.ts failed`;
  await engine.execute(master, 'rework', work.id, { reason: reason2, previousWorkerStopped: true, binding: `${'3'.repeat(40)}:merge-writer-trial-failed` }, randomUUID());

  // Round 4: stub Builder launches -> refused by acceptance proof (3rd counted refusal).
  await cycle();
  assert.equal(launches.length, 4, 'attempt 4 launches (only 2 counted refusals so far)');
  assert.match(launches[3].brief, /Attempt 1 \(review\):/);
  assert.match(launches[3].brief, /Attempt 2 \(base moved\):/);
  assert.match(launches[3].brief, /Attempt 3 \(merge trial\):/);
  const reason3 = `${work.key}: a trusted proof failed: e2e:third-failure-goes-to-the-lead failed on 444444444444`;
  await engine.execute(master, 'rework', work.id, { reason: reason3, previousWorkerStopped: true, binding: `${'4'.repeat(40)}:proof:e2e:third-failure-goes-to-the-lead` }, randomUUID());

  // After the 3rd counted refusal: NO automatic launch, ONE decision raised for the master naming all 3 refusals.
  await cycle();
  await cycle();
  assert.equal(launches.length, 4, 'no automatic attempt launches after the third refusal');
  const leadWakes = wakes.filter(text => text.includes('needs the Lead: failed 3 times'));
  assert.equal(leadWakes.length, 1, `expected exactly one Lead decision wake, got ${leadWakes.length}: ${JSON.stringify(wakes)}`);
  assert.ok(leadWakes[0].includes('missing validation on input'), 'decision names refusal 1');
  assert.ok(leadWakes[0].includes('tests/alpha.test.ts failed'), 'decision names refusal 2');
  assert.ok(leadWakes[0].includes('e2e:third-failure-goes-to-the-lead failed'), 'decision names refusal 3');
  assert.match(leadWakes[0], /revise the requirements/i);
  assert.match(leadWakes[0], /split into smaller items/i);
  assert.match(leadWakes[0], /park with a summary/i);

  // master status shows the item as 'needs the Lead: failed 3 times'.
  await writeFile(daemonStatePath(config), JSON.stringify(state));
  const statusRoot = await temporaryDirectory('third-failure-status');
  execFileSync('git', ['init', '-q', statusRoot]);
  const currentWork = await store.list();
  const status = await masterStatusReport(
    statusRoot,
    config,
    async () => ({ work: currentWork, now: iso() }),
    async (command, args) => isHerdrCommand(command)
      ? (herdrSubcommand(args)[1] === 'list' ? JSON.stringify({ agents: [{ name: 'master', pane_id: 'pM', agent_status: 'working' }] }) : 'Coordinating work.')
      : `${'b'.repeat(40)}\n`,
  );
  const row = status.items.find((entry: { key: string }) => entry.key === work.key);
  assert.ok(row, 'item appears in master status');
  assert.equal(row.waiting, 'needs the Lead: failed 3 times');

  // Once the Lead answers (e.g. revises requirements), automatic dispatch resumes.
  const latest = await reload();
  await engine.execute(master, 'requirements', work.id, {
    expectedPolicyRevision: latest.policyRevision,
    reason: 'Clarified input validation rules after three refusals',
    criteria: [{ id: 'AC-1', text: 'Works cleanly with clarified rules', proofs: ['e2e:third-failure-goes-to-the-lead'] }],
    dependencies: [],
    exclusiveResources: [],
  }, randomUUID());
  await cycle();
  assert.equal(launches.length, 5, 'revising requirements resumes automatic dispatch');
  } finally {
    await store.close();
  }
});
