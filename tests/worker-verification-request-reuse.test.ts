import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { runWorkerVerification } from '../src/merge-writer/worker-verification.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { verificationQueue } from '../src/server/worker-verification-queue.js';
import { completeCommand } from '../src/cli/complete.js';
import type { CliContext } from '../src/cli/context.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { listen } from './helpers/http-server.js';
import { lifecycle } from './helpers/work-lifecycle.js';
import { until } from './helpers/until.js';
import { api } from './helpers/api.js';

setRepositoryPolicy({ ...repositoryPolicy(), risk: { sensitive: [{ glob: 'app.js', rule: 'fixture requires independent review' }], declared: true }, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

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
  git('add', '.'); git('commit', '-qm', 'implementation\n\nAC-1 — met: reuse fixture');
  const head = git('rev-parse', 'HEAD');
  const store = await withDatabase('verification-reuse'); await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  const operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-test-token' };
  const host = { id: 'host', role: 'coordinator' as const, token: 'host-test-token' };
  engine.principals = [operator, worker, host];
  let work = await lifecycle(engine, operator, { type: 'chore', title: 'Reuses a pending verification', criteria: [{ id: 'AC-1', text: 'Required validation', proofs: ['integration:reuse-required', 'e2e:fixture'] }] }, { claim: worker, workspace: { host: 'test', path: root, branch: 'graphyard/reuse' } });
  const { url: serverUrl, close } = await listen(server(engine, [worker, host]));
  t.after(close);
  const url = serverUrl;
  const call = async (path: string, body?: unknown, token = host.token, signal?: AbortSignal) => {
    const result = await api(url, token, path, { body, signal });
    if (result.status !== 200) throw new Error(`${result.status}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const start = (input: Record<string, unknown> = {}, signal?: AbortSignal) => call(`work/${work.id}/worker-verification`, { mode: 'verify', head, epoch: 1, ...input }, worker.token, signal)
    .then(value => ({ value, error: null }), error => ({ value: null, error }));
  const pending = async () => (await call('work-snapshot')).workerVerifications as any[];
  const result = { record: { key: work.key, head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] }, rerun: { flaked: [], baseFailures: [] } };
  return { root, git, head, work, store, api: call, start, pending, result, worker };
}

test('integration:worker-verification-request-reuse — identical repeats share one host verification; changed inputs and stale epochs do not', async t => {
  const f = await fixture(t);
  const waitMs = verificationQueue.waitMs; verificationQueue.waitMs = 5_000; t.after(() => { verificationQueue.waitMs = waitMs; });
  const first = f.start(), repeat = f.start();
  await until(async () => (await f.pending()).length >= 1, 'request queued', 3_000, 10);
  await delay(100); // Let the repeat reach the server.
  assert.equal((await f.pending()).length, 1, 'a repeat of the same work, epoch, head and inputs joins the pending verification');
  // Changed verification inputs run their own job.
  const changed = f.start({ preserves: ['kept'] });
  await until(async () => (await f.pending()).length === 2, 'changed inputs queue their own verification', 3_000, 10);
  // A stale lease epoch is refused, never joined.
  const stale = await f.start({ epoch: 2 });
  assert.match(String(stale.error), /40[39]/);
  assert.equal((await f.pending()).length, 2);
  const jobs = await f.api('worker-verifications/take', { host: 'test' });
  assert.equal(jobs.length, 2);
  const same = jobs.find((job: any) => !job.input.preserves), other = jobs.find((job: any) => job.input.preserves);
  await f.api('worker-verifications/finish', { id: same.id, result: f.result });
  const [a, b] = await Promise.all([first, repeat]);
  assert.deepEqual(a.value, f.result); assert.deepEqual(b.value, f.result);
  assert.equal((await f.pending()).length, 1, 'the changed-input job is still pending');
  await f.api('worker-verifications/finish', { id: other.id, error: 'runner failed' });
  assert.match(String((await changed).error), /422.*runner failed/);
  assert.deepEqual(await f.pending(), []);
  // Once settled, the same identity runs a fresh verification.
  const again = f.start();
  await until(async () => (await f.pending()).length === 1, 'a later request queues anew', 3_000, 10);
  const [next] = await f.api('worker-verifications/take', { host: 'test' });
  assert.ok(![same.id, other.id].includes(next.id));
  await f.api('worker-verifications/finish', { id: next.id, result: f.result });
  assert.deepEqual((await again).value, f.result);
  // A caller whose time runs out while the host runs its verification leaves it running; the repeat joins it.
  verificationQueue.waitMs = 300;
  const timedOut = f.start();
  await until(async () => (await f.pending()).length === 1, 'the verification queues', 3_000, 10);
  const [running] = await f.api('worker-verifications/take', { host: 'test' });
  assert.match(String((await timedOut).error), /504.*timed out/);
  verificationQueue.waitMs = 5_000;
  const rejoined = f.start();
  await delay(100);
  assert.deepEqual((await f.pending()).map(entry => entry.state), ['running'], 'the repeat joins the running verification');
  assert.deepEqual(await f.api('worker-verifications/take', { host: 'test' }), []);
  await f.api('worker-verifications/finish', { id: running.id, result: f.result });
  assert.deepEqual((await rejoined).value, f.result);
});

test('e2e:worker-verification-request-reuse — an interrupted verify and its repeat run one host verification and complete submits through unchanged gates', { timeout: 240_000 }, async t => {
  const f = await fixture(t);
  // The caller gives up while host admission is still waiting; the request itself stays queued.
  const abort = new AbortController();
  const interrupted = f.start({ preserves: [] }, abort.signal);
  await until(async () => (await f.pending()).length === 1, 'first request queued', 3_000, 10);
  abort.abort();
  assert.ok((await interrupted).error);
  const printed: any[] = [];
  const context = { args: [], repositoryRoot: () => f.root,
    api: (path: string, body?: unknown) => f.api(path, body, f.worker.token), print: (value: any) => printed.push(value) } as unknown as CliContext;
  // The worker's repeat — the same verification inputs from `mainworks verify`, a caller whose key order differs — joins it.
  const { verifyCommand } = await import('../src/cli/verify.js');
  const verifying = verifyCommand.run(context, f.work).then(() => null, error => error);
  await delay(200);
  const queued = await f.pending();
  assert.equal(queued.length, 1, 'the repeat joins the queued verification');
  assert.equal(queued[0].state, 'queued');
  let executions = 0;
  const pump = workerVerificationPump(f.root, () => 'test', f.api, () => f.root, undefined, async (...args) => {
    executions++;
    return runWorkerVerification(...args);
  });
  await pump();
  const verifyError = await verifying;
  if (verifyError) throw verifyError;
  assert.equal(executions, 1);
  // With the verification recorded, complete submits the head; no gate changed.
  const completed = completeCommand.run({ ...context, args: ['1', '--head', f.head] }, f.work).then(() => null, error => error);
  const completionError = await completed;
  if (completionError) throw completionError;
  const recorded = (await f.store.list()).find(work => work.id === f.work.id)!;
  assert.equal(recorded.candidate?.sha, f.head); assert.equal(recorded.submission?.epoch, 1);
  assert.equal(recorded.lease, null); assert.equal(recorded.pipeline?.attempts.length, 1);
  assert.equal(recorded.gates.find(gate => gate.name === 'review')?.passed, false);
  assert.equal(recorded.gates.find(gate => gate.name === 'acceptance')?.passed, false);
  assert.notEqual(recorded.stage, 'done');
  const ran = (await f.store.events(f.work.id)).filter(event => event.kind === 'work.self-verified').at(-1)!.payload.details.record.ran;
  assert.ok(ran.some((run: any) => run.proof === 'integration:reuse-required' && run.result === 'pass' && run.executed > 0), JSON.stringify(ran));
  assert.equal(printed.length, 2);
  assert.equal(printed.at(-1).selfVerification.state, 'passing', JSON.stringify(printed.at(-1).selfVerification));
  assert.deepEqual(await f.pending(), []);
});
