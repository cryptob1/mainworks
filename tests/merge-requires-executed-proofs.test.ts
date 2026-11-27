import { freePort } from '../src/cli/test-isolation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { mergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { mergeOne, runMergeTrial, type MergeRecordEvent } from '../src/merge-writer/executor.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { defaultRepositoryPolicy } from '../src/model/repository-policy.js';
import { setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import type { Principal, Work } from '../src/model.js';
import { listen } from './helpers/http-server.js';
import { lifecycle } from './helpers/work-lifecycle.js';
import { apiOk } from './helpers/api.js';

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };

// The bound command case runs this same real regression inside the native private-root trial.
test('unit:tests/merge-requires-executed-proofs.test.ts integration:merge-requires-executed-proofs — the writer refuses absent, zero-count and failing proofs before pushing; explicit TAP lands through the ordinary control plane', { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('required-proofs');
  const servePort = await freePort();
  let store: Store | undefined, close: (() => Promise<void>) | undefined;
  try {
    store = await withDatabase('merge-requires-executed-proofs'); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    const { url, close: stop } = await listen(server(engine, [{ ...coordinator, token }])); close = stop;
    setRepositoryPolicy({ ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });
    let branchNumber = 0;
    for (const mode of ['spec', 'missing', 'failed', 'tap'] as const) {
      const directory = join(root, mode);
      const repo = await gitRepo({ root: join(directory, 'checkout'), label: `executed-proofs-${mode}`, origin: true }), checkout = repo.root, origin = repo.origin;
      const write = async (path: string, value: string) => { await mkdir(join(checkout, path, '..'), { recursive: true }); await writeFile(join(checkout, path), value); };
      const reporter = mode === 'spec' ? 'spec' : 'tap';
      // Even a command that exits successfully cannot turn a failing TAP case into accepted proof.
      await write('package.json', JSON.stringify({ scripts: { build: 'node --eval 0', test: `node --test --test-reporter=${reporter} proof.cjs${mode === 'failed' ? '; true' : ''}` } }));
      await write('proof.cjs', `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\ntest('unit:declared', () => { assert.equal(${mode === 'failed' ? '1, 2' : '1, 1'}); });\n`);
      // The trial serves the real head before running its bound command case.
      await write('serve.cjs', `require('node:http').createServer((q,s)=>s.end('ok')).listen(${servePort}, '127.0.0.1');\n`);
      await write('graphyard.json', JSON.stringify({ e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'node serve.cjs', url: `http://127.0.0.1:${servePort}`, readySeconds: 1 } } }));
      await write('e2e/cases/fixture.json', JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'served head command', run: 'node --eval 0' }] }));
      git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'base'); git(checkout, 'push', '-q', 'origin', 'main');
      const baseTip = git(origin, 'rev-parse', 'main');
      engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
      const works: Work[] = [];
      for (let n = 0; n < 1; n++) {
        const branch = `graphyard/gy-${++branchNumber}-1`;
        git(checkout, 'checkout', '-qb', branch, baseTip);
        await write(`change-${n}.txt`, 'change'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'change');
        const head = git(checkout, 'rev-parse', 'HEAD');
        const proof = mode === 'missing' ? 'integration:absent' : 'unit:declared';
        let work = await lifecycle(engine, operator, { type: 'chore', title: `${mode}-${n}`, criteria: [{ id: 'AC-1', text: 'Works', proofs: [proof, 'e2e:fixture'] }, { id: 'AC-2', text: 'Observe after deployment', proofs: ['manual:post-deploy/observed'] }] }, { claim: worker, workspace: { host: 'fixture', path: join(directory, branch), branch }, submit: { head } });
        assert.equal(work.gates.find(gate => gate.name === 'build')?.passed, true);
        assert.equal(work.gates.find(gate => gate.name === 'review')?.passed, true);
        works.push(work);
      }
      git(checkout, 'checkout', '-q', 'main');
      let pushes = 0;
      const records: { key: string; event: MergeRecordEvent }[] = [];
      // The bound E2E runs in the normal private root, including nested trial wrappers.
      // A worker has no Docker socket and already inherits confinement: fixture commands run
      // directly there, with the same real output and the trusted harness resolved locally.
      const fixtureRun: ChildRun = async (command, args, options) => {
        if (command === 'git' && args.includes('push')) pushes++;
        // This tiny E2E child must exit after its server stops, without waiting out the
        // 20-second shutdown grace timer on every trial.
        if (args.includes('/mainworks-harness/node_modules/tsx/dist/loader.mjs')) options = { ...options, timeoutMs: 15_000 };
        if (!existsSync('/etc/graphyard-trial') && options?.wrapper?.length) {
          if (args.includes('/mainworks-harness/node_modules/tsx/dist/loader.mjs')) {
            const script = args.at(-1)!;
            const harness = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
            await writeFile(script, (await readFile(script, 'utf8')).replaceAll('/mainworks-harness', harness));
            args = args.map(arg => arg === '/mainworks-harness/node_modules/tsx/dist/loader.mjs' ? fileURLToPath(new URL(import.meta.resolve('tsx'))) : arg);
          }
          return defaultChildRun(command, args, { ...options, wrapper: [] });
        }
        return defaultChildRun(command, args, options);
      };
      const reads = mergeWriterReads(masterConfigSchema.parse({ version: 1, repository: 'owner/proofs', baseBranch: 'main', url, credentialFile: '/unused', cliPath: '/unused', githubAppId: 1, hostId: 'fixture', masterAgentName: 'fixture', workers: [], run: { mergeWriter: { deployKeyFile: join(directory, 'unused-key') } } }), checkout,
        fixtureRun, {
          base: join(directory, 'managed'),
          trial: input => runMergeTrial({ ...input, retries: 0, attribute: false }),
          record: async (work, event) => {
            records.push({ key: work.key, event });
            await apiOk(url, token, `work/${work.id}/merge-record`, { body: event });
          },
        });
      const results = [{ work: works[0]!, outcome: await mergeOne(reads, works[0]!) }];
      for (const result of results) {
        assert.ok('outcome' in result, JSON.stringify(result));
        assert.equal(result.outcome.outcome, mode === 'tap' ? 'merged' : 'refused', `${mode}: ${JSON.stringify(result)}`);
        const work: Work = (await store.workDocument(result.work.id))!;
        assert.equal(!!work.delivery, mode === 'tap');
        const trials = records.filter(entry => entry.key === work.key && entry.event.kind === 'trial').map(entry => entry.event);
        assert.ok(trials.length >= 1, 'the trial history is retained');
        for (const trial of trials) {
          assert.ok(trial.kind === 'trial' && trial.outcome === 'verdict');
          assert.equal(trial.build, 'pass', JSON.stringify(result.outcome)); assert.deepEqual(trial.tests.failed, []);
          assert.deepEqual(trial.proofs[mode === 'missing' ? 'integration:absent' : 'unit:declared'], { executed: mode === 'spec' || mode === 'missing' ? 0 : 1, failed: mode === 'failed' ? 1 : 0 });
        }
        if (mode !== 'tap') assert.match(work.mergeLedger!.refusal!.reason, new RegExp(`${mode === 'missing' ? 'integration:absent' : 'unit:declared'}.*executed > 0.*failed = 0`));
      }
      assert.equal(pushes, mode === 'tap' ? 1 : 0, 'no refused trial invokes the leased push');
      assert.equal(git(origin, 'rev-parse', 'main') === baseTip, mode !== 'tap', 'remote main changes only for positive passing counts');
    }
  } finally { await close?.(); if (store) await store.close(); await rm(root, { recursive: true, force: true }); } });
