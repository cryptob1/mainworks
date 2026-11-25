import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readServeRecord, serveOnce, serveRecordPath, type ServeDeclaration, type ServePorts } from '../src/serve-app.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3855: pin the fresh-port retry in serveOnce. When no port is recorded yet and another
// process claims the ephemeral port in the window between allocatePort() and restart() binding it,
// serveOnce retries with a fresh port instead of failing the first serve.

const declaration: ServeDeclaration = { id: 'game', kind: 'node', directory: 'apps/game', build: 'node build.js', start: 'node serve.js' };

test('unit:managed-serve-pinned — serveOnce retries with a fresh port when another process takes a freshly allocated port before restart binds it', async () => {
  const root = await temporaryDirectory('managed-serve-port-race');
  const foreign = createServer((_request, response) => response.writeHead(200).end('foreign\n'));
  const ours = createServer((_request, response) => response.writeHead(200).end('ours\n'));
  await new Promise<void>(done => foreign.listen(0, '127.0.0.1', done));
  await new Promise<void>(done => ours.listen(0, '127.0.0.1', done));
  const stolenPort = (foreign.address() as { port: number }).port;
  const ownPort = (ours.address() as { port: number }).port;
  try {
    const candidates = [stolenPort, ownPort];
    const tried: number[] = [];
    const ports: ServePorts = {
      fetch: async () => 'a'.repeat(40),
      declaration: async () => declaration,
      checkout: async () => {},
      install: async () => {},
      build: async () => {},
      restart: async (_decl, boundPort) => {
        tried.push(boundPort);
        return { pid: process.pid, started: null };
      },
      answersFromRestart: (port) => port === ownPort,
    };

    const result = await serveOnce(serveRecordPath(root), ports, () => {}, {
      answerTimeoutMs: 2_000,
      freePort: async () => {
        const next = candidates.shift();
        if (!next) throw new Error('unexpected extra port allocation');
        return next;
      },
    });
    assert.equal(result, 'served');
    assert.deepEqual(tried, [stolenPort, ownPort]);
    assert.equal(readServeRecord(serveRecordPath(root))?.commit, 'a'.repeat(40));
    assert.equal(readServeRecord(serveRecordPath(root))?.url, `http://127.0.0.1:${ownPort}`);
  } finally {
    foreign.closeAllConnections?.();
    ours.closeAllConnections?.();
    await Promise.all([
      new Promise<void>(done => foreign.close(() => done())),
      new Promise<void>(done => ours.close(() => done())),
    ]);
  }
});
