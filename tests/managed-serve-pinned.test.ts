import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readServeRecord, serveOnce, serveRecordPath, type ServeDeclaration, type ServePorts } from '../src/serve-app.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3786: pin the determinism fixes for tests/managed-serve.test.ts and serveOnce.
// Choosing a free port before checkout, install and build leaves that ephemeral port unbound for
// seconds (or minutes) while other processes or concurrent test files can take it, making the
// subsequent serve fail to bind. Choosing the port right before restart eliminates that window.

const declaration: ServeDeclaration = { id: 'game', kind: 'node', directory: 'apps/game', build: 'node build.js', start: 'node serve.js' };

test('GY-3786 — serveOnce chooses a free port after checkout, install and build finish so concurrent work cannot claim it during the build', async () => {
  const root = await temporaryDirectory('managed-serve-pinned');
  const order: string[] = [];
  const server = createServer((_request, response) => response.writeHead(200).end('ok\n'));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  try {
    const ports: ServePorts = {
      fetch: async () => 'a'.repeat(40),
      declaration: async () => declaration,
      checkout: async () => { order.push('checkout'); },
      install: async () => { order.push('install'); },
      build: async () => { order.push('build'); },
      restart: async (_decl, boundPort) => {
        order.push(`restart:${boundPort}`);
        return { pid: process.pid, started: null };
      },
      answersFromRestart: () => true,
    };

    const allocatePort = async () => {
      order.push('freePort');
      return port;
    };

    const result = await serveOnce(serveRecordPath(root), ports, () => {}, { answerTimeoutMs: 2_000, freePort: allocatePort });
    assert.equal(result, 'served');
    assert.deepEqual(order, ['checkout', 'install', 'build', 'freePort', `restart:${port}`]);
    assert.equal(readServeRecord(serveRecordPath(root))?.url, `http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>(done => server.close(() => done()));
  }
});
