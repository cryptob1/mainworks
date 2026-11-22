import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { builderFixture } from './helpers/builder-fixture.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { dispatchWork } from '../src/master.js';
import { reworkWorktreePath } from '../src/cli/workspace-worktree.js';
import { trialFailureRework } from '../src/daemon/cycle-merge-writer.js';
import { reportedModel } from '../src/master/runtimes.js';
import { recordSessionModel } from '../src/model/account-quota.js';
import type { HeadlessExec } from '../src/headless-session.js';
import type { Principal, Work } from '../src/model.js';

// GY-3687: an account registered for claude-opus-5 whose login home would answer on
// claude-fable-5-2 when no model is named — on a stored Claude runtime that names no model flag,
// the contract the 2026-11-22 fable session launched on. A worker start and its rework continue
// both report the registered model, and the account stays available.

const proof = 'e2e:home-default-does-not-change-the-model';
const registered = 'claude-opus-5', homeDefault = 'claude-fable-5-2';

test(`${proof} — a worker start and its rework continue run the registered model, not the login's default`, { timeout: 120_000 }, async t => {
  const yard = await builderFixture('home-default-model', { modelFlag: null, args: ['--dangerously-skip-permissions'] });
  // The stub runtime answers on the model its --model names, or on its home's default when none is named.
  const outputs: string[] = [];
  const exec: HeadlessExec = async (command, args, options) => {
    await yard.exec(command, args, options);
    const runtime = args.slice(args.indexOf('--') + 1), named = runtime.indexOf('--model');
    const model = named >= 0 ? runtime[named + 1]! : homeDefault;
    const text = JSON.stringify({ type: 'result', result: 'done', session_id: `session-${yard.runs.length}`, modelUsage: { [model]: { inputTokens: 1, outputTokens: 1 } } });
    appendFileSync(join(options.run, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), stream: 'stdout', text })}\n`);
    outputs.push(text);
    return '';
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await writeFile(join(yard.root, 'README.md'), '# Fixture\n');
  git(yard.root, 'add', 'README.md'); git(yard.root, 'commit', '-q', '-m', 'base');
  git(yard.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

  const store = await withDatabase('home-default-model');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project');
  engine.gitRunner = gitRunnerFor(yard.root); engine.baseBranch = 'main';
  const operator: Principal = { id: 'operator', role: 'admin' }, worker: Principal = { id: yard.profile.principal, role: 'worker' };
  const run = (actor: Principal, command: string, id: string | null, data: unknown) => engine.execute(actor, command as never, id, data, randomUUID());

  let work: Work = await run(operator, 'create', null, { type: 'feature', title: 'Widgets', criteria: [{ id: 'AC-1', text: 'Two widgets', proofs: [proof] }] });
  work = await run(operator, 'ready', work.id, {});
  const branch = `graphyard/${work.key.toLowerCase()}-1`;
  const prepare = async () => {
    const pulled = await engine.pullAssignment(worker, { work: work.id }, randomUUID());
    assert.equal(pulled.assigned?.id, work.id, JSON.stringify(pulled.refused));
    const claimed = pulled.assigned!, epoch = claimed.lease!.epoch;
    const path = reworkWorktreePath(claimed, branch, yard.hostId) ?? join(yard.root, '.graphyard', 'worktrees', `${claimed.key}-${epoch}`);
    if (epoch === 1) git(yard.root, 'worktree', 'add', '-q', '-b', branch, path);
    work = await run(worker, 'workspace', work.id, { epoch, host: yard.hostId, path, branch });
    return { epoch, path, base: git(yard.root, 'rev-parse', 'HEAD'), work: claimed };
  };
  const dispatch = async () => dispatchWork(yard.root, work, yard.profile, { allWork: [work], prepare, release: async () => {}, headless: exec, probe: yard.probe(), startupMs: 2_000 });

  // Worker start.
  const first = await dispatch();
  const builder = yard.runs[0]!;
  await writeFile(join(builder.cwd, 'widget.ts'), 'export const widgets = 1;\n');
  git(builder.cwd, 'add', 'widget.ts'); git(builder.cwd, 'commit', '-q', '-m', 'widgets');
  const head = git(builder.cwd, 'rev-parse', 'HEAD');
  work = await run(worker, 'submit', work.id, { epoch: first.epoch, head });

  // Rework continue of the same session.
  const grounded = trialFailureRework(work, head, 'trial failed: tests/widget.test.ts expected 2 widgets, got 1');
  work = await run(operator, 'rework', work.id, { reason: grounded.reason, ...grounded.input });
  const second = await dispatch();
  assert.equal(second.continued?.session, 'session-1', 'the rework continues the first session');

  const registry = await yard.client.document();
  for (const [index, launch] of ['worker start', 'rework continue'].entries()) {
    const words = yard.runs[index]!.runtime;
    assert.equal(words[words.indexOf('--model') + 1], registered, `${launch} names the registered id: ${words.join(' ')}`);
    assert.ok(!words.includes('opus'), `${launch} passes no alias`);
    const ran = reportedModel('claude', outputs[index]!);
    assert.equal(ran, registered, `${launch} reports the registered model`);
    assert.equal(recordSessionModel(registry, builder.account, ran, { actor: 'executor', at: new Date().toISOString() }), false, `${launch} leaves ${builder.account} in service`);
  }
  assert.ok(yard.runs[1]!.runtime.includes('--resume'), 'the second run is the continue form');
  const account = registry.accounts.find(entry => entry.name === builder.account)!;
  assert.notEqual(account.quota.state, 'broken', `${builder.account} stays available`);
});
