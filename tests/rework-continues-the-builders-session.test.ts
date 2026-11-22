import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dispatchWork } from '../src/master.js';
import { headlessArgs } from '../src/headless-argv.js';
import { runtimeSessionId } from '../src/model/token-costs.js';
import { attemptLabel, readAttemptLaunch } from '../src/master/session-resume.js';
import { builderFixture } from './helpers/builder-fixture.js';

// GY-3632: a change sent back for rework returns to the Builder that wrote it: the same account's
// runtime continues its own session in the same worktree, with the rework reason as its next
// message. A held account, an unknown session id or a continue launch that fails starts fresh, as
// before, with the reason recorded.

const proof = 'unit:rework-continues-the-builders-session';
const reason = 'trial failed: tests/widget.test.ts expected 2 widgets, got 1';

test(`${proof} — the Claude, Codex and OpenCode adapters produce their continue arguments, and each run's session id is read from what it printed`, () => {
  assert.deepEqual(headlessArgs('claude', ['--permission-mode', 'bypassPermissions'], 'fix it', null, [], 's-1'), ['--permission-mode', 'bypassPermissions', '-p', '--output-format', 'json', '--resume', 's-1', 'fix it']);
  assert.deepEqual(headlessArgs('codex', ['--sandbox', 'workspace-write'], 'fix it', null, [], 't-1'), ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--json', 'resume', 't-1', 'fix it']);
  assert.deepEqual(headlessArgs('opencode', [], 'fix it', null, ['--standalone'], 'ses_1'), ['run', '--format', 'json', '--standalone', '--session', 'ses_1', 'fix it']);
  assert.deepEqual(headlessArgs('claude', [], 'go'), ['-p', '--output-format', 'json', 'go'], 'a fresh launch is unchanged');
  assert.throws(() => headlessArgs('pi', [], 'go', null, [], 'x'), /no continue form/);
  assert.equal(runtimeSessionId('{"type":"result","session_id":"9f1c-aa","result":"ok"}'), '9f1c-aa');
  assert.equal(runtimeSessionId('{"type":"thread.started","thread_id":"0199-abc"}\n{"type":"turn.completed"}'), '0199-abc');
  assert.equal(runtimeSessionId('{"type":"step_start","sessionID":"ses_42"}'), 'ses_42');
  assert.equal(runtimeSessionId('plain text'), null);
});

async function scenario(label: string) {
  const yard = await builderFixture(label);
  const path = join(yard.root, '.graphyard', 'worktrees', 'GY-1-1');
  await mkdir(path, { recursive: true });
  let claims = 0;
  // The worktree command gives a rework its branch's last path (reworkWorktreePath); a moved worktree is a fresh path.
  const prepare = (moved = false) => async () => ({ epoch: ++claims, path: moved ? join(yard.root, 'moved') : path, base: 'c'.repeat(40) });
  const item = { id: 'work-1', key: 'GY-1', title: 'Widgets', description: '', type: 'feature', priority: 1, dependencies: [], lane: 'low', pipeline: { reworkRounds: 0, attempts: [] },
    criteria: [{ id: 'AC-1', text: 'Two widgets', proofs: [proof] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as any;
  const dispatch = (work: any, moved = false) => dispatchWork(yard.root, work, yard.profile, { allWork: [work], prepare: prepare(moved), release: async () => {}, headless: yard.exec, probe: yard.probe(), startupMs: 2_000 });
  const first = await dispatch(item);
  const sentBack = () => ({ ...item, epoch: claims, stage: 'build', reworkRequested: true, submission: { epoch: claims, head: 'a'.repeat(40) }, candidate: { sha: 'a'.repeat(40), branch: 'graphyard/gy-1-1' },
    pipeline: { reworkRounds: 1, attempts: [], submittedAt: new Date(Date.now() - 60_000).toISOString() }, lastRework: { reason, binding: null, at: new Date().toISOString() } });
  return { yard, path, first, dispatch, sentBack };
}

test(`${proof} — a rework continues the last attempt's session on its account in its worktree, the reason first; a held account, an unknown session or a failed continue launch starts fresh with the reason recorded`, { timeout: 120_000 }, async () => {
  // Continue: the same account resumes the first run's session, in the same worktree, and the request opens with the reason.
  const { yard, path, first, dispatch, sentBack } = await scenario('builder-continue');
  assert.equal(first.continued, null);
  assert.equal(first.fresh, null, 'a first launch is no rework');
  const builder = yard.runs[0]!;
  const second = await dispatch(sentBack());
  const resumed = yard.runs.at(-1)!;
  assert.deepEqual(resumed.runtime.slice(-2), ['--resume', 'session-1'], 'the continue form with the first run\'s session id');
  assert.ok(resumed.request.startsWith(reason), 'its first message is the rework reason');
  assert.match(resumed.request, /complete GY-1 2 --head/);
  assert.equal(resumed.cwd, path);
  assert.equal(resumed.account, builder.account, 'the same account');
  assert.deepEqual(second.continued, { from: 1, session: 'session-1', account: builder.account, path });
  assert.equal(second.fresh, null);
  const recorded = await readAttemptLaunch(yard.root, 'GY-1');
  assert.equal(recorded?.resumedFrom, 1, 'the launch is recorded as a continued attempt');
  assert.equal(attemptLabel(2, recorded), 'attempt 2: rework by the same Builder');

  // A further rework continues the session the continued run printed.
  yard.printSessions(n => n === 3 ? null : `session-${n}`);
  await dispatch(sentBack());
  assert.deepEqual(yard.runs.at(-1)!.runtime.slice(-2), ['--resume', 'session-2']);
  // That run printed no session id: the next rework starts fresh and says why.
  const unknown = await dispatch(sentBack());
  assert.equal(unknown.continued, null);
  assert.match(unknown.fresh ?? '', /printed no session id/);
  assert.ok(!yard.runs.at(-1)!.runtime.includes('--resume'));
  assert.ok(!yard.runs.at(-1)!.request.startsWith(reason), 'a fresh launch gets the full brief');
  assert.match(yard.runs.at(-1)!.request, /Implement GY-1/);
  assert.equal(attemptLabel(4, await readAttemptLaunch(yard.root, 'GY-1')), 'attempt 4');
  assert.match((await readAttemptLaunch(yard.root, 'GY-1'))?.fresh ?? '', /printed no session id/);

  // The account is held: fresh on the other account, with the reason.
  yard.printSessions(n => `session-${n}`);
  await dispatch(sentBack());
  yard.disable(yard.runs.at(-1)!.account!);
  const held = await dispatch(sentBack());
  assert.equal(held.continued, null);
  assert.match(held.fresh ?? '', /is not available/);
  assert.ok(!yard.runs.at(-1)!.runtime.includes('--resume'));
  assert.notEqual(yard.runs.at(-1)!.account, yard.runs.at(-2)!.account);

  // The continue launch fails at once: the same dispatch starts fresh in the same worktree.
  yard.failWhen(runtime => runtime.includes('--resume'));
  const failed = await dispatch(sentBack());
  assert.deepEqual(yard.runs.at(-2)!.runtime.slice(-2), ['--resume', `session-${yard.runs.length - 2}`], 'the continue launch was tried');
  assert.ok(!yard.runs.at(-1)!.runtime.includes('--resume'));
  assert.equal(yard.runs.at(-1)!.cwd, path);
  assert.equal(failed.continued, null);
  assert.match(failed.fresh ?? '', /continue launch failed/);
  yard.failWhen(() => false);

  // The worktree moved: fresh.
  const moved = await dispatch(sentBack(), true);
  assert.equal(moved.continued, null);
  assert.match(moved.fresh ?? '', /worktree moved/);
});
