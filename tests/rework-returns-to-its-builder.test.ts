import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { builderFixture } from './helpers/builder-fixture.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { dispatchWork } from '../src/master/dispatch.js';
import { itemLine } from '../src/cli/master-status.js';
import { reworkWorktreePath } from '../src/cli/workspace-worktree.js';
import { trialFailureRework } from '../src/daemon/cycle-merge-writer.js';
import { readAttemptLaunch } from '../src/master/session-resume.js';
import type { Principal, Work } from '../src/model.js';

// GY-3632: an item runs on a stub runtime through submit, a merge trial's refusal and the rework
// it grounds, on a real store. The rework's launch continues the first attempt's runtime session
// on the same account in the same worktree, and master status shows 'rework by the same Builder'.

const proof = 'e2e:rework-returns-to-its-builder';

test(`${proof} — a refused head's rework continues its Builder's session on the same account in the same worktree`, { timeout: 120_000 }, async t => {
  const yard = await builderFixture('rework-returns-to-its-builder');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await writeFile(join(yard.root, 'README.md'), '# Fixture\n');
  git(yard.root, 'add', 'README.md'); git(yard.root, 'commit', '-q', '-m', 'base');
  git(yard.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const store = await withDatabase('rework-returns-to-its-builder');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project');
  engine.gitRunner = gitRunnerFor(yard.root); engine.baseBranch = 'main';
  const operator: Principal = { id: 'operator', role: 'admin' }, worker: Principal = { id: yard.profile.principal, role: 'worker' };
  const run = (actor: Principal, command: string, id: string | null, data: unknown) => engine.execute(actor, command as never, id, data, randomUUID());

  let work: Work = await run(operator, 'create', null, { type: 'feature', title: 'Widgets', criteria: [{ id: 'AC-1', text: 'Two widgets', proofs: [proof] }] });
  work = await run(operator, 'ready', work.id, {});
  const branch = `graphyard/${work.key.toLowerCase()}-1`;
  // The launcher's claim and worktree, as prepareWorkerLaunch and the worktree command make them.
  const prepare = async () => {
    const pulled = await engine.pullAssignment(worker, { work: work.id }, randomUUID());
    assert.equal(pulled.assigned?.id, work.id, JSON.stringify(pulled.refused));
    const claimed = pulled.assigned!, epoch = claimed.lease!.epoch;
    const path = reworkWorktreePath(claimed, branch, yard.hostId) ?? join(yard.root, '.graphyard', 'worktrees', `${claimed.key}-${epoch}`);
    if (epoch === 1) git(yard.root, 'worktree', 'add', '-q', '-b', branch, path);
    work = await run(worker, 'workspace', work.id, { epoch, host: yard.hostId, path, branch });
    return { epoch, path, base: git(yard.root, 'rev-parse', 'HEAD'), work: claimed };
  };
  const dispatch = async () => dispatchWork(yard.root, work, yard.profile, { allWork: [work], prepare, release: async () => {}, headless: yard.exec, probe: yard.probe(), startupMs: 2_000 });

  // Attempt 1: the stub Builder writes and submits.
  const first = await dispatch();
  const builder = yard.runs[0]!;
  await writeFile(join(builder.cwd, 'widget.ts'), 'export const widgets = 1;\n');
  git(builder.cwd, 'add', 'widget.ts'); git(builder.cwd, 'commit', '-q', '-m', 'widgets');
  const head = git(builder.cwd, 'rev-parse', 'HEAD');
  work = await run(worker, 'submit', work.id, { epoch: first.epoch, head });
  assert.equal(work.submission?.epoch, 1);

  // The merge trial refuses the head; the loop applies the rework its refusal grounds.
  const refusal = 'trial failed: tests/widget.test.ts expected 2 widgets, got 1';
  const grounded = trialFailureRework(work, head, refusal);
  work = await run(operator, 'rework', work.id, { reason: grounded.reason, ...grounded.input });
  assert.equal(work.reworkRequested, true);

  // Attempt 2 continues the first attempt's session, on its account, in its worktree, the reason first.
  const second = await dispatch();
  const resumed = yard.runs.at(-1)!;
  assert.equal(second.epoch, 2);
  assert.deepEqual(resumed.runtime.slice(-2), ['--resume', 'session-1'], 'the continue form with the first attempt\'s session id');
  assert.equal(resumed.account, builder.account, 'the same account');
  assert.equal(resumed.cwd, builder.cwd, 'the same worktree');
  assert.ok(resumed.request.startsWith(grounded.reason), 'its first message is the rework reason');
  assert.equal(work.workspaces.at(-1)?.path, builder.cwd, 'the rework reserved its Builder\'s worktree');
  assert.deepEqual(second.continued, { from: 1, session: 'session-1', account: builder.account, path: builder.cwd });

  // Master status shows the item as reworked by the same Builder.
  const line = itemLine(work, Date.now(), await readAttemptLaunch(yard.root, work.key));
  assert.match(line.attempt ?? '', /rework by the same Builder/);
});
