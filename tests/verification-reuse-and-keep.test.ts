import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { verifyWorkingTree } from '../src/cli/verify.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { completeCommand } from '../src/cli/complete.js';
import { requestWorkerVerification } from '../src/cli/worker-verification.js';
import type { CliContext } from '../src/cli/context.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { listen } from './helpers/http-server.js';
import { lifecycle } from './helpers/work-lifecycle.js';
import { until } from './helpers/until.js';
import { apiOk } from './helpers/api.js';

setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3543: a passed verification of a head is not run again for that head, and a result that
// outlives its lease is kept unless a newer request for the item replaced it.

async function fixture(t: TestContext) {
  const root = await temporaryDirectory('verification-reuse', process.cwd());
  const { git } = await gitRepo({ root, files: { '.gitignore': '.graphyard/\nnode_modules/\n', 'package.json': '{"type":"module"}', 'app.js': 'export const answer = 0;\n' } });
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-qb', 'graphyard/reuse');
  await writeFile(join(root, 'app.js'), 'export const answer = 42;\n');
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'tests/required.test.ts'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../app.js';
test('integration:reuse-required', () => assert.equal(answer, 42));
`);
  git('add', '.'); git('commit', '-qm', 'implementation');
  const head = git('rev-parse', 'HEAD');
  const store = await withDatabase('verification-reuse'); await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  const operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-test-token' };
  const host = { id: 'host', role: 'coordinator' as const, token: 'host-test-token' };
  engine.principals = [operator, worker, host];
  let work = await lifecycle(engine, operator, { type: 'chore', title: 'Reuse and keep verification', criteria: [{ id: 'AC-1', text: 'Required validation', proofs: ['integration:reuse-required', 'e2e:fixture'] }] }, { claim: worker, workspace: { host: 'test', path: root, branch: 'graphyard/reuse' } });
  const { url: serverUrl, close } = await listen(server(engine, [worker, host]));
  t.after(close);
  const url = serverUrl;
  const api = (path: string, body?: unknown, token = host.token) => apiOk(url, token, path, { body });
  const pending = async () => (await api('work-snapshot')).workerVerifications as unknown[];
  const verified = async () => (await store.events(work.id)).filter(event => event.kind === 'work.self-verified');
  return { root, git, head, work, store, api, pending, verified, worker };
}

test('integration:verification-reuse-and-keep — verify then complete on the same head runs the proof files once; another head runs them again', { timeout: 300_000 }, async t => {
  const f = await fixture(t);
  const printed: any[] = [];
  const context = { args: ['1', '--head', f.head], repositoryRoot: () => f.root,
    api: (path: string, body?: unknown) => f.api(path, body, f.worker.token), print: (value: any) => printed.push(value) } as unknown as CliContext;
  let executions = 0;
  // The host's run of the proof files, here in the checkout itself rather than a trial container.
  const pump = workerVerificationPump(f.root, () => 'test', f.api, () => f.root, undefined, async (root, work) => {
    executions++;
    return { record: await verifyWorkingTree(work, root), rerun: { flaked: [], baseFailures: [] } };
  });
  const verify = async (head = f.head) => {
    const request = requestWorkerVerification(context, f.work, { mode: 'verify', head, epoch: 1 });
    const settled = request.then(() => true, () => true);
    await until(async () => await Promise.race([settled, delay(5).then(() => false)]) || (await f.pending()).length === 1, 'verify answered or queued', 5_000, 10);
    await pump();
    return request;
  };
  const first = await verify();
  assert.equal(executions, 1);
  assert.ok(first.record.ran.some(run => run.proof === 'integration:reuse-required' && run.result === 'pass' && run.executed > 0), JSON.stringify(first.record.ran));
  // The same head under the same policy revision is answered from the passed record.
  const again = await verify();
  assert.equal(executions, 1, 'a passed head is not run again');
  assert.deepEqual(again.record, first.record);
  assert.equal((await f.verified()).length, 1);

  // Any other head runs them as before.
  await writeFile(join(f.root, 'tests/required.test.ts'), (await readFile(join(f.root, 'tests/required.test.ts'), 'utf8')) + '// another head\n');
  f.git('commit', '-qam', 'another head\n\nAC-1 — met: verification passed');
  const head = f.git('rev-parse', 'HEAD');
  await verify(head);
  assert.equal(executions, 2, 'another head runs its proof files');
  await verify(head);
  assert.equal(executions, 2);
  const args = ['1', '--head', head];
  await completeCommand.run({ ...context, args } as CliContext, f.work);
  assert.equal(executions, 2, 'complete runs no proof files for a passed head');
  const recorded = (await f.store.list()).find(work => work.id === f.work.id)!;
  assert.equal(recorded.candidate?.sha, head); assert.equal(recorded.submission?.epoch, 1);
  assert.equal(recorded.passedVerification?.head, head);
  assert.equal(recorded.passedVerification?.policyRevision, recorded.policyRevision);
  assert.equal((await f.verified()).length, 2);
  assert.equal(printed.length, 1);
});

test('integration:verification-reuse-and-keep — a result that outlives its lease is kept for its head unless a newer request replaced it', async t => {
  const f = await fixture(t);
  const lapse = () => f.store.pool.query(`UPDATE work_items SET document=jsonb_set(document, '{lease,expiresAt}', to_jsonb($2::text)) WHERE id=$1`, [f.work.id, new Date(Date.now() - 1000).toISOString()]);
  const start = (input: Record<string, unknown> = {}) => f.api(`work/${f.work.id}/worker-verification`, { head: f.head, epoch: 1, mode: 'verify', ...input }, f.worker.token).then(value => ({ value, error: null }), error => ({ value: null, error }));
  const result = { record: { key: f.work.key, head: f.head, clean: true, at: new Date().toISOString(),
    ran: [{ proof: 'integration:reuse-required', criteria: ['AC-1'], result: 'pass', executed: 1, failed: 0, skipped: 0, files: ['tests/required.test.ts'] }], outstanding: [] },
  rerun: { flaked: [], baseFailures: [] } };
  const older = start();
  await until(async () => (await f.pending()).length === 1, 'first request queued', 5_000, 10);
  const [first] = await f.api('worker-verifications/take', { host: 'test' });
  // An identical repeat would join the first request; a newer request differs in its inputs.
  const newer = start({ preserves: ['kept'] });
  await until(async () => (await f.pending()).length === 2, 'newer request queued', 5_000, 10);
  const [second] = await f.api('worker-verifications/take', { host: 'test' });
  await lapse();
  // The older request's result is replaced by the newer one: not recorded.
  await f.api('worker-verifications/finish', { id: first.id, result });
  assert.match(String((await older).error), /Lease missing, expired, or superseded/);
  assert.equal((await f.verified()).length, 0);
  // The newest request's result arrives after the lease lapsed and is still recorded for its head.
  await f.api('worker-verifications/finish', { id: second.id, result });
  assert.deepEqual((await newer).value, result);
  const kept = await f.verified();
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.payload.details.lapsed, true);
  const recorded = (await f.store.list()).find(work => work.id === f.work.id)!;
  assert.equal(recorded.passedVerification?.head, f.head);
  assert.deepEqual(recorded.passedVerification?.result, result);
});
