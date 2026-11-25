import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server } from 'node:net';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { shardSshSession } from '../src/merge-writer/remote-shards.js';
import { shardHosts, sshdHost } from './helpers/shard-hosts.js';

// GY-3824: sshd frees a session only after its client exits, so it may refuse the next session over a shared
// connection; ssh then connected directly, past the trial's 3-connection bound. The host here is a real OpenSSH
// server with MaxSessions 1 behind a proxy that counts connections.

let bin: string, target: string, server: { kill(): void }, proxy: Server, opened = 0;

before(async () => {
  const hosts = await shardHosts('ssh-session-refused', ['compute']);
  const sshd = await sshdHost(hosts.root, hosts.shim, hosts.home('compute'), join(hosts.root, 'hosts', 'compute', 'bin'), hosts.bin);
  server = sshd; bin = hosts.bin; target = `${sshd.user}@127.0.0.1`;
  const config = join(hosts.root, 'sshd', 'sshd_config');
  sshd.kill(); await writeFile(config, `${await readFile(config, 'utf8')}MaxSessions 1\n`); await sshd.start();
  proxy = createServer(socket => {
    opened++;
    const upstream = connect(sshd.port, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    const done = () => { socket.destroy(); upstream.destroy(); };
    socket.once('close', done); upstream.once('close', done); socket.on('error', done); upstream.on('error', done);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const wrapper = join(bin, 'ssh'), port = (proxy.address() as { port: number }).port;
  await writeFile(wrapper, execFileSync('cat', [wrapper], { encoding: 'utf8' }).replace(` -p ${sshd.port} `, ` -p ${port} `)); await chmod(wrapper, 0o755);
});
after(() => { server?.kill(); proxy?.close(); });

const run: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${bin}:${process.env.PATH}` } });

test('unit:ssh-reuse-per-host-pinned — a session sshd refuses while it still holds one the transport released retries its own connection, never opening a new one', { timeout: 120_000 }, async () => {
  const transport = shardSshSession(run);
  try {
    // The race's one condition, injected: sshd still holds its only session slot, which the transport has released.
    const held = await transport.session(target, words => new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
      const child = spawn(join(bin, 'ssh'), ['-v', ...words, `update-shim ${'0'.repeat(64)}`], { stdio: ['pipe', 'ignore', 'pipe'] });
      let said = '';
      child.stderr.on('data', chunk => { said += String(chunk); if (/master session id/.test(said)) resolve(child); });
      child.once('exit', () => reject(new Error(said)));
    }));
    let refusals = 0;
    const probe = await transport.session(target, words => Promise.resolve(run('ssh', [...words, 'probe'])).catch((error: unknown) => { refusals++; held.stdin!.end(); throw error; }));
    assert.match(String(probe), /^verbs /m);
    assert.ok(refusals > 0, 'sshd refused the session over the shared connection');
    assert.equal(opened, 1, 'the refused session opened no new SSH connection');
  } finally { await transport.close(); }
});
