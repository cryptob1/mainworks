import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { join } from 'node:path';
import { defaultChildRun } from '../src/child-runner.js';
import { shardHosts, sshdHost } from './helpers/shard-hosts.js';

// GY-3841: sshdHost's readiness loop previously probed by binding 127.0.0.1:<port> itself
// (createServer().listen(port, '127.0.0.1', () => socket.close(...))). Whenever sshd executed
// bind() during that probe's bind-to-close window, sshd failed with EADDRINUSE and exited,
// causing sshdHost to throw 'sshd did not listen'.
test('unit:remote-ssh-confined-pinned — sshdHost waits for sshd to listen without binding its port and colliding with sshd bind()', { timeout: 60_000 }, async () => {
  const hosts = await shardHosts('remote-ssh-confined-pinned', ['loopback']);
  let probeBinds = 0;
  const originalListen = Server.prototype.listen;
  const originalClose = Server.prototype.close;

  // Test seam: intercept any bind on a non-zero loopback port (i.e. a readiness probe binding
  // sshd's port, not freePort()'s port 0) and hold the probe socket open long enough for the
  // concurrently spawned sshd to hit EADDRINUSE on its own bind(), reproducing the race every run.
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    if (typeof args[0] === 'number' && args[0] > 0) {
      probeBinds++;
      if (probeBinds === 1) (this as Server & { __holdProbe?: boolean }).__holdProbe = true;
    }
    return originalListen.apply(this, args as Parameters<Server['listen']>);
  } as typeof Server.prototype.listen;
  Server.prototype.close = function (this: Server, cb?: (err?: Error) => void) {
    if ((this as Server & { __holdProbe?: boolean }).__holdProbe) {
      setTimeout(() => originalClose.call(this, cb), 250);
      return this;
    }
    return originalClose.call(this, cb);
  };

  let server: { kill(): void; user: string; port: number } | undefined;
  try {
    server = await sshdHost(hosts.root, hosts.shim, hosts.home('loopback'), join(hosts.root, 'hosts', 'loopback', 'bin'), hosts.bin);
    assert.equal(probeBinds, 0, 'sshdHost must not bind sshd\'s port to probe readiness');
    const out = await defaultChildRun(join(hosts.bin, 'ssh'), [`${server.user}@127.0.0.1`, 'probe'], { timeoutMs: 10_000 });
    assert.match(out, /^verbs /m, 'sshd accepts SSH connections as soon as sshdHost resolves');
  } finally {
    Server.prototype.listen = originalListen;
    Server.prototype.close = originalClose;
    server?.kill();
  }
});
