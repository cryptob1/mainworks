import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Principal } from '../src/model.js';
import { checkoutRepositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { defaultRepositoryPolicy } from '../src/model/repository-policy.js';
import { defineScenario } from '../src/scenarios.js';
import { parseCase } from '../src/e2e/case.js';
import { projectCaseSuite } from '../src/release-project.js';
import { runCases, type E2eReport } from '../src/e2e/runner.js';
import { trialEnvironment } from '../src/merge-writer/trial.js';
import { remoteableTestFile } from '../src/merge-writer/remote-shards.js';
import { freePort } from './helpers/http-server.js';


// GY-2969: Mainworks's own graphyard.json declares e2e.serve, so its user-facing items can carry
// e2e: proofs. AC-1: the declared command serves this head's control plane and create-work-item
// passes against it; stopping it removes its database directory. AC-2: create accepts a feature
// carrying e2e:create-work-item under this head's policy.

const checkout = process.cwd();
const policy = checkoutRepositoryPolicy(checkout);

test('unit:mainworks-repo-serves-its-head-for-e2e — the declared serve command passes core product and delivery cases, and stopping it removes its database directory', { timeout: 240_000 }, async t => {
  const serve = policy.e2e.serve;
  assert.ok(serve, 'graphyard.json declares e2e.serve');
  // stdout/stderr stay open while any descendant that inherited them still runs (the shell may exit first).
  const whenClosed = (stream: NodeJS.ReadableStream | null) =>
    !stream || (stream as NodeJS.ReadableStream & { closed?: boolean }).closed
      ? Promise.resolve()
      : new Promise<void>(accept => stream.once('close', () => accept()));
  // The trial's environment: no credential, TMPDIR the serve's own. Readiness is polled from spawn.
  // GY-3893: the bounded waits' timers are unref'd, so a stop that finishes early never holds the process open.
  const startServe = async (label: string, token: string, port: number) => {
    const scratch = await temporaryDirectory(label);
    const url = new URL(serve.url); url.port = String(port);
    const child = spawn('sh', ['-c', serve.command], { cwd: checkout, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...trialEnvironment(process.env), TMPDIR: scratch, GRAPHYARD_E2E_TOKEN: token, GRAPHYARD_E2E_SERVE_PORT: String(port) } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const descendantsGone = Promise.all([whenClosed(child.stdout), whenClosed(child.stderr)]);
    const answered = (async () => {
      const deadline = Date.now() + serve.readySeconds * 1000;
      while (Date.now() < deadline && child.exitCode === null) {
        if (await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false)) return true;
        await new Promise(accept => setTimeout(accept, 100));
      }
      return false;
    })();
    // Wait for the serving process to finish cleanup (not the shell's exit).
    const stop = async () => {
      process.kill(-child.pid!, 'SIGTERM');
      await Promise.race([descendantsGone, new Promise(accept => setTimeout(accept, 20_000).unref())]);
    };
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
    return { scratch, url, answered, stop, kill, output: () => output };
  };
  const token = `trial-${randomUUID()}`;
  // GY-3195: the declared port is shared by every serve on the host (a merge trial, another run of
  // this file); this run serves on a free port of its own so its cases never reach another's server.
  const port = await freePort();
  let otherPort = await freePort();
  while (otherPort === port) otherPort = await freePort();
  // GY-3666 / GY-3692: another serve in this checkout (a worker's, tests/worker-serve-own-port.test.ts) starts and stops
  // beside this run; it starts alongside this run's serve so neither waits on the other's startup.
  const main = await startServe('e2e-serve', token, port);
  const other = await startServe('e2e-serve-other', `other-${randomUUID()}`, otherPort);
  const { scratch, url } = main;
  try {
    assert.ok(await main.answered, `${url} answered within ${serve.readySeconds}s: ${main.output().slice(-2000)}`);
    // GY-3658: this file runs the delivery-pipeline case, a real nested merge trial that a remote
    // shard's missing nested confinement fails, so the shard split must keep this file local.
    await t.test('unit:graphyard-e2e-serve-pinned — the serve command answers on the port the run gives it, with the run\'s token, whatever holds the declared port, and this file never goes to a remote shard', async () => {
      assert.equal(remoteableTestFile(readFileSync(new URL(import.meta.url), 'utf8')), false, 'the delivery-pipeline case keeps this file on a local shard');
      assert.notEqual(url.port, new URL(serve.url).port);
      const listed = await fetch(new URL('/api/scenarios', url), { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(listed.status, 200, 'the server on the given port is this run\'s: it accepts the run\'s token');
      // The seed this run's cases read stays this serve's own after the other serve stops.
      try {
        assert.ok(await other.answered, `${other.url} answered within ${serve.readySeconds}s`);
        await other.stop();
      } finally { other.kill(); }
      const seed = JSON.parse(readFileSync(join(checkout, '.graphyard', `e2e-serve-${port}.json`), 'utf8'));
      const own = await fetch(new URL('/api/scenarios', url), { headers: { Authorization: `Bearer ${seed.delivery.coordinatorToken}` } });
      assert.equal(own.status, 200, 'the seed names this serve\'s delivery credentials after another serve stopped');
    });
    const databases = readdirSync(scratch).filter(name => name.startsWith('graphyard-e2e-serve-'));
    assert.equal(databases.length, 1, 'the database lives in one temporary directory under TMPDIR');

    const ids = ['capacity-limit-redispatch', 'create-work-item', 'every-item-owes-e2e', 'board', 'work-item-detail', 'single-case-criterion-warned'];
    const cases = ids.map(id => {
      const file = `e2e/cases/${id}.json`;
      return { file, definition: parseCase(file, readFileSync(join(checkout, file), 'utf8')) };
    });
    // GY-4045: the cases' command steps run whole test files and need nothing an earlier step captured,
    // so each runs as its own part beside the case's other steps and the other cases; one after another
    // they were 20 s of create-work-item alone. Every step of every case still runs and must pass.
    const parts = cases.flatMap(({ file, definition }) => {
      const others = definition.steps.filter(step => step.kind !== 'command');
      const groups = [...(others.length ? [others] : []), ...definition.steps.filter(step => step.kind === 'command').map(step => [step])];
      return groups.map(steps => ({ file, definition: { ...definition, steps } }));
    });
    const outcomes: E2eReport['cases'] = [];
    const core = Promise.all(parts.map((part, index) => projectCaseSuite(checkout, token, { cases: [part], select: () => true,
      withholdSecrets: true, artifactsDirectory: join(scratch, 'artifacts', String(index)), signal: AbortSignal.timeout(180_000), report: value => { outcomes.push(...value.cases); } })
      .run(url.origin, null)));

    // GY-3038: the same served head must actually deliver to its scratch bare origin. A push
    // failure after a passing build/test trial must fail this case, never manufacture delivery.
    const delivery = t.test('unit:delivery-pipeline — the case delivers a reviewed exact head and fails after a passing trial when the bare origin is unwritable', async () => {
      const deliveryFile = 'e2e/cases/delivery-pipeline.json';
      const definition = parseCase(deliveryFile, readFileSync(join(checkout, deliveryFile), 'utf8'));
      const deliveryOptions = { url: url.origin, token, environment: 'uat', root: checkout,
        retries: 0, withholdSecrets: true, signal: AbortSignal.timeout(180_000), artifactsDirectory: join(scratch, 'delivery-artifacts') };
      const passed = await runCases([{ file: deliveryFile, definition }], deliveryOptions);
      assert.equal(passed.cases[0]?.verdict, 'passed', JSON.stringify(passed.cases[0]?.failingStep));
      const broken = structuredClone(definition);
      assert.equal(broken.steps[0].kind, 'command');
      if (broken.steps[0].kind === 'command') broken.steps[0].run += ' --unwritable';
      const failed = await runCases([{ file: deliveryFile, definition: broken }], deliveryOptions);
      assert.equal(failed.cases[0]?.verdict, 'failed', 'the same case fails with an unwritable origin');
      assert.match(failed.cases[0]?.failingStep?.reason ?? '', /permission denied|unpacker error|unable to create/i);
      const items = await fetch(`${deliveryOptions.url}/api/work`, { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json()) as any[];
      const refused = items.find(item => item.title.startsWith('Scratch delivery') && item.stage !== 'done');
      assert.ok(refused, 'the failed push leaves the item undelivered');
      assert.equal(refused.delivery, undefined);
      assert.equal(refused.mergeLedger.state, 'intent');
      assert.equal(refused.mergeLedger.trial.build, 'pass', 'the fault reaches the real push after a passing build');
      assert.deepEqual(refused.mergeLedger.trial.proofs['unit:scratch-delivery'], { executed: 1, failed: 0 });
      assert.deepEqual(refused.mergeLedger.trial.proofs['e2e:scratch-delivery'], { executed: 1, failed: 0 }, 'the served scratch head passes its E2E check before the push fails');
    });
    // GY-3893: the delivery case pushes to its own scratch origin and finds its item by its own title, so it
    // runs beside the core cases instead of after them.
    await Promise.all([core, delivery]);
    for (const id of ids) {
      const ran = outcomes.filter(entry => entry.id === id);
      assert.equal(ran.length, parts.filter(part => part.definition.id === id).length, `${id}: every part reported`);
      for (const outcome of ran) assert.equal(outcome.verdict, 'passed', `${id}: ${JSON.stringify(outcome.failingStep ?? outcome)}`);
    }


    await main.stop();
    assert.deepEqual(readdirSync(scratch).filter(name => name.startsWith('graphyard-e2e-serve-')), [], 'stopping the command removes its database directory');
  } finally { main.kill(); other.kill(); }
});

let store: Store, engine: Engine;
const operator: Principal = { id: 'operator', role: 'admin' };

before(async () => {
  store = await withDatabase('graphyard-e2e-serve'); await store.init();
  engine = new Engine(store, 120, 'cryptob1/graphyard');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
});
after(async () => { setRepositoryPolicy(defaultRepositoryPolicy); if (store) await store.close(); });

test('unit:mainworks-feature-with-e2e-proof-accepted — create accepts a feature for cryptob1/graphyard whose criterion carries e2e:create-work-item under this head’s policy', async () => {
  setRepositoryPolicy(policy);
  await defineScenario(store, operator, { id: 'create-work-item', title: 'An operator creates a work item and finds it in the work list', purpose: 'An operator creates a work item',
    steps: ['POST /api/work', 'GET /api/work'], expected: ['the item is listed'], environment: 'any', runner: 'graphyard-e2e', testPath: 'e2e/cases/create-work-item.json' }, randomUUID());
  const work = await engine.execute(operator, 'create', null, { title: 'A user-visible change', type: 'feature',
    criteria: [{ id: 'AC-1', text: 'An operator creates a work item', proofs: ['e2e:create-work-item'] }] }, randomUUID());
  assert.equal(work.type, 'feature');
  assert.deepEqual(work.criteria[0].proofs, ['e2e:create-work-item']);
});
