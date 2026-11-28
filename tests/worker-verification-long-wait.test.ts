import { listen } from './helpers/http-server.js';
import { patchEnv } from './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/cli/context.js';
import { requestWorkerVerification } from '../src/cli/worker-verification.js';
import { verificationRequestTimeoutMs } from '../src/cli/verification-request.js';
import { gitRepo } from './helpers/git-repo.js';

test('unit:worker-verification-long-wait — verify survives six minutes before headers; timeout and unreachable stay distinct', async t => {
  const { root, head } = await gitRepo({ label: 'verification-long-wait', files: {}, message: 'fixture' });
  let mode: 'long' | 'timeout' | 'body-timeout' | 'refusal' | 'disconnect' = 'long';
  let submitted = false, verificationCalls = 0;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  // AbortSignal.timeout uses internal timers: connect its requested duration to the virtual clock.
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  const { url, close } = await listen(async (req, res) => {
    if (req.url === '/healthz') { res.end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url?.endsWith('/worker-verification')) {
      verificationCalls++;
      assert.equal(req.headers.authorization, 'Bearer test-token');
      assert.ok(req.headers['idempotency-key']);
      assert.deepEqual(JSON.parse(body), { mode: 'verify', head, epoch: 1 });
      if (mode === 'disconnect') { t.mock.timers.tick(60_000); req.socket.destroy(); return; }
      if (mode === 'refusal') { res.writeHead(409); res.end('{"error":"verification refused"}'); return; }
      if (mode === 'body-timeout') { res.writeHead(200); res.write('{'); }
      if (mode === 'timeout' || mode === 'body-timeout') { t.mock.timers.tick(verificationRequestTimeoutMs); return; }
      t.mock.timers.tick(6 * 60_000);
      res.end(JSON.stringify({ record: { key: 'GY-1', head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] }, rerun: { flaked: [], baseFailures: [] } }));
      return;
    }
    assert.equal(req.url, '/api/work/id-1/submit');
    assert.deepEqual(JSON.parse(body), { epoch: 1, head });
    submitted = true; res.end('{"submitted":true}');
  });
  const restoreEnv = patchEnv({ GRAPHYARD_URL: url, GRAPHYARD_TOKEN: 'test-token', GRAPHYARD_TOKEN_FILE: undefined });
  const complete = async () => {
    const context = await createContext('complete', 'GY-1', ['1', '--head', head], false);
    context.repositoryRoot = () => root;
    context.print = () => {};
    await requestWorkerVerification(context, { id: 'id-1', key: 'GY-1' }, { mode: 'verify', epoch: 1 });
  };
  try {
    await complete();
    assert.equal(submitted, false);
    // Verification records are local-only, as in an assigned repository.
    await import('node:fs/promises').then(fs => fs.writeFile(`${root}/.git/info/exclude`, '.graphyard/\n'));
    for (const next of ['timeout', 'body-timeout', 'refusal', 'disconnect'] as const) {
      mode = next; submitted = false;
      const before = verificationCalls;
      await assert.rejects(complete(), next === 'disconnect' ? /Control plane unreachable.*after 60 seconds/ : next === 'refusal' ? /verification refused/ : /Worker verification timed out.*after 60 minutes/);
      assert.equal(submitted, false);
      assert.equal(verificationCalls, before + 1, 'no replay of timeout or HTTP refusal');
    }
    // A closed listener is an actual connection failure, not a verification timeout.
    await close();
    const context = await createContext('complete', 'GY-1', [], false);
    t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
    t.mock.method(Date, 'now', (() => { let now = 0; return () => now += 60_000; })());
    await assert.rejects(context.api('work/id-1/worker-verification', {}), /Control plane unreachable.*after 60 seconds/);
  } finally {
    await close();
    restoreEnv();
  }
});
