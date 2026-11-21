import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { startHeadlessWorker } from '../src/headless-session.js';
import { checkoutRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
import { commandApplication, serveHead } from '../src/merge-writer/serve-head.js';
import { trialEnvironment } from '../src/merge-writer/trial.js';
import { clearRuns } from '../src/runner/registry.js';
import { freePort } from '../src/serve-app.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3584: a worker session serving its head for its own browser tests held 127.0.0.1:4391, the
// address graphyard.json declares, so a product review serving another item there failed with
// "already answers before the serve command starts". A worker session now carries
// GRAPHYARD_E2E_SERVE_PORT, a free port of its own, which scripts/e2e-serve.mjs serves on; reviews
// and trials keep the declared address.

const repo = fileURLToPath(new URL('..', import.meta.url));
after(() => clearRuns());

const answers = (url: string) => fetch(url, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok, () => false);

test('integration:worker-serve-own-port — a worker session\'s e2e serve binds its own free port, never 4391, and a review serves the declared address beside it', { timeout: 300_000 }, async () => {
  const serve = checkoutRepositoryPolicy(repo).e2e.serve;
  assert.ok(serve, 'graphyard.json declares e2e.serve');
  assert.equal(new URL(serve.url).port, '4391', 'the declared address reviews and trials serve on');
  const base = await temporaryDirectory('worker-serve-own-port');
  await mkdir(join(base, 'bin'));
  await writeFile(join(base, 'bin', 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const root = await temporaryDirectory('worker-serve-own-port-root', base);

  // The worker session's runtime serves its head with the declared command and its own environment, as a worker running e2e locally does.
  let seen: Record<string, string> = {}, served = '', output = '';
  let stopServe = () => {};
  await startHeadlessWorker({ name: 'eng-pi', work: 'GY-3584', subject: 'GY-3584: own port', epoch: 1, principal: 'worker-a', account: null, kind: 'pi', args: [],
    environment: { PATH: `${join(base, 'bin')}:${process.env.PATH}`, MISE_NO_CONFIG: '1' }, directory: repo, supervisor: [], prompt: 'Implement it.', root, timeoutMs: 290_000, startupMs: 1,
    exec: async (_command, _args, options) => {
      seen = options.env;
      const child = spawn('sh', ['-c', serve.command], { cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...trialEnvironment(options.env), TMPDIR: await temporaryDirectory('worker-serve-own-port-tmp', base), GRAPHYARD_E2E_TOKEN: `worker-${randomUUID()}`, ...(options.env.GRAPHYARD_E2E_SERVE_PORT ? { GRAPHYARD_E2E_SERVE_PORT: options.env.GRAPHYARD_E2E_SERVE_PORT } : {}) } });
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      stopServe = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ } };
      return new Promise<string>(done => child.on('close', () => done(output)));
    } });
  clearRuns();
  try {
    const port = seen.GRAPHYARD_E2E_SERVE_PORT;
    assert.match(port ?? '', /^\d+$/, 'the worker session carries GRAPHYARD_E2E_SERVE_PORT');
    assert.notEqual(port, '4391', 'never the declared port');
    served = `http://127.0.0.1:${port}/healthz?ready`;
    const deadline = Date.now() + serve.readySeconds * 1000;
    while (!await answers(served) && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 500));
    assert.ok(await answers(served), `the worker's e2e serve answered on its own port ${port}: ${output.slice(-2000)}`);

    // A product review of another item serves its head on the declared address while the worker's serve runs.
    // A merge trial running this case holds 4391 itself, so the review's declared address here is a free port of the fixture's.
    const declared = new URL(serve.url); declared.port = String(await freePort());
    assert.notEqual(declared.port, port);
    const review = serveHead(base, commandApplication({ command: `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${declared.port},'127.0.0.1')"`, url: declared.href, readySeconds: 30 }),
      { sha: 'a'.repeat(40), env: trialEnvironment(process.env), budgetMs: 60_000, scratch: base });
    try { assert.equal(await review.ready, declared.origin, 'the review serves on its declared address'); }
    finally { await review.close(); }
  } finally { stopServe(); }
});
