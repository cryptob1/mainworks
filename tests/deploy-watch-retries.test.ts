// GY-3703: a verified commit whose deploy failed is tried again by the running watch after a
// bounded backoff, instead of waiting for the next verified commit; the first success serves it
// and clears controlPlaneUpdate.failedStep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { controlPlaneRecordPath, deployRecordPath, readControlPlaneRecord, readDeployRecord, watchMain, type DeployWatchPorts } from '../src/deploy-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40);

test('integration:deploy-watch-retries — a build and then a restart that each fail once end with the verified commit served on /healthz by the same watch process, with the failed step cleared', { timeout: 60_000 }, async () => {
  // The control plane: /healthz reports the commit the last successful restart started.
  let running = a;
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ healthy: true, commit: running })); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/healthz`;
  const served = async () => ((await (await fetch(url)).json()) as { commit: string }).commit;

  const root = await temporaryDirectory('deploy-watch-retries'), file = deployRecordPath(root);
  const failOnce = new Set(['build', 'restart']);
  const failedSteps: (string | null)[] = [];
  const ports: DeployWatchPorts = {
    fetch: async () => b, head: async () => a,
    build: async () => { if (failOnce.delete('build')) throw new Error('npm ci: network unreachable'); },
    restart: async commit => { if (failOnce.delete('restart')) throw new Error('docker compose up timed out'); running = commit; },
    health: async commit => { if (await served() !== commit) throw new Error(`/healthz reports ${running.slice(0, 12)}`); },
    checkout: async () => {}, pin: async () => {}, prune: async () => {},
    schema: async () => 1, database: async () => 1,
    retryBackoffMs: [100, 200],
  };
  const controller = new AbortController();
  const log = (line: string) => { failedSteps.push(readControlPlaneRecord(controlPlaneRecordPath(root))?.failedStep ?? null); void line; };
  const watch = watchMain(file, ports, { intervalMs: 20, signal: controller.signal, log });
  try {
    for (const start = Date.now(); readDeployRecord(file)?.tip !== b; await new Promise(done => setTimeout(done, 20))) {
      if (Date.now() - start > 20_000) assert.fail(`the watch never served ${b.slice(0, 12)}: ${JSON.stringify(readDeployRecord(file))}`);
    }
    assert.ok(failedSteps.includes('build') && failedSteps.includes('restart'), 'both one-off failures were recorded before the retry that served');
    assert.equal(await served(), b, '/healthz reports the verified commit');
    const control = readControlPlaneRecord(controlPlaneRecordPath(root))!;
    assert.deepEqual([control.commit, control.failedStep, readDeployRecord(file)?.failed], [b, null, null], 'the first success clears the failure');
  } finally {
    controller.abort(); await watch;
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
});
