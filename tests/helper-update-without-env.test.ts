import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimScript } from '../src/host-shim.js';
import { helperSigningKeyFile, readHostReadings } from '../src/hosts.js';
import { encodeLoopHosts, loopHosts } from '../src/model/loop-presence.js';
import { shardHosts } from './helpers/shard-hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { listen } from './helpers/http-server.js';

const proof = 'integration:helper-update-without-env e2e:helper-update-without-env';

test(`${proof} — the shipped helper under the previous launcher updates without optional settings and remains signed-only`, async t => {
  const saved = process.env.GRAPHYARD_CONFIG_HOME;
  process.env.GRAPHYARD_CONFIG_HOME = await temporaryDirectory('missing-signers-config');
  try {
    const hosts = await shardHosts('missing-signers', ['box'], {});
    const target = 'gy-compute@box';
    const file = join(hosts.root, 'hosts.json');
    await writeFile(file, JSON.stringify([{ target, login: 'vish@box', addedAt: '2026-11-20T00:00:00Z' }]));
    const own = join(hosts.home('box'), '.graphyard/shims/graphyard-host-shim-');
    await mkdir(join(hosts.home('box'), '.graphyard/shims'), { recursive: true });
    // GY-3895's launcher, with a clean environment, exercises the helper this release ships.
    // Relocate only the host-add signers path into the fixture's isolated filesystem.
    const installed = hostShimScript.replaceAll('/etc/ssh/graphyard_helper_signers', join(hosts.root, 'mainworks-helper-signers'));
    await writeFile(own, installed);
    await writeFile(hosts.shim, `#!/bin/sh
exec /usr/bin/env -i HOME="$HOME" PATH="$PATH" SSH_ORIGINAL_COMMAND="$SSH_ORIGINAL_COMMAND" MAINWORKS_SHIM="$HOME/.graphyard/shims/graphyard-host-shim-" /bin/sh "$HOME/.graphyard/shims/graphyard-host-shim-" "$@"
`);
    const run: ChildRun = (command, args, options) => {
      assert.notEqual(command, 'sudo');
      return defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
    };
    const call = (verb: string, input = '') => spawnSync(join(hosts.bin, 'ssh'), [target, verb], {
      input, encoding: 'utf8', env: { ...process.env, PATH: `${hosts.bin}:${process.env.PATH}` },
    });
    const digest = createHash('sha256').update(hostShimScript).digest('hex');
    const signed = execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', helperSigningKeyFile(), '-n', 'mainworks-helper'], { input: hostShimScript, encoding: 'utf8' });
    assert.match(call('probe').stdout, /update-shim:2/);
    const wrongKey = join(hosts.root, 'wrong-key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', wrongKey]);
    const wrongSignature = execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', wrongKey, '-n', 'mainworks-helper'], { input: hostShimScript, encoding: 'utf8' });
    for (const input of [hostShimScript, wrongSignature + hostShimScript]) {
      const refused = call(`update-shim ${digest}`, input);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /refuses the update: no key this host was prepared with signed it/);
      assert.equal(await readFile(own, 'utf8'), installed, 'refused payload leaves the helper intact');
    }
    const accepted = call(`update-shim ${digest}`, signed + hostShimScript);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(await readFile(own, 'utf8'), hostShimScript);
    // A running install's next loop sees an older helper lacking a verb (GY-3952) and sends the next signed helper.
    await writeFile(own, installed.replace(hostShimDigest, 'a'.repeat(64)).replace(' receive-image:4', ''));
    const [{ withDatabase }, { Engine }, { server }, presence] = await Promise.all([
      import('./helpers/postgres.js'), import('../src/engine.js'), import('../src/server.js'), import('../src/model/loop-presence.js'),
    ]);
    const store = await withDatabase('helper-update-without-env');
    await store.init();
    t.after(() => store.close());
    const engine = new Engine(store, 120, 'fixture/helpers');
    engine.gitRunner = null;
    const token = 'helper-update-loop-token-xxxxxxxxxxxxxxxx';
    const { url: serverUrl, close } = await listen(server(engine, [{ id: 'loop', role: 'coordinator', sessionKind: 'ai', token }]));
    t.after(close);
    const url = serverUrl;
    const readings = await readHostReadings([], { file, run, local: 'here', update: true });
    const reading = loopHosts(encodeLoopHosts(readings))!.find(entry => entry.host === target)!;
    assert.equal(reading.away, false, readings.find(entry => entry.host === target)?.reason);
    assert.equal(reading.older, undefined);
    const published = await fetch(`${url}/api/work-snapshot`, { headers: {
      Authorization: `Bearer ${token}`, [presence.loopPresenceHeader]: '15',
      [presence.loopSupervisionHeader]: 'autonomous', [presence.loopHostsHeader]: encodeLoopHosts(readings),
    } });
    assert.equal(published.status, 200);
    const status = await (await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).json() as { hosts: Array<{ host: string; away: boolean; older?: boolean }> };
    assert.equal(status.hosts.find(host => host.host === target)?.away, false);
    assert.equal(status.hosts.find(host => host.host === target)?.older, undefined);
    const probe = call('probe');
    assert.match(probe.stdout, new RegExp(`^shim ${hostShimDigest}$`, 'm'));
    assert.match(probe.stdout, /update-shim:2/);
    assert.doesNotMatch(probe.stdout, /update-shim:1/);
    // The v1 wire format is the unsigned script. The installed copy must refuse it.
    assert.equal(call(`update-shim ${digest}`, hostShimScript).status, 1);
    const shared = spawnSync('sh', [own, '--home', hosts.home('box')], {
      input: signed + hostShimScript, encoding: 'utf8',
      env: { ...process.env, HOME: hosts.home('box'), MAINWORKS_SHIM: own, SSH_ORIGINAL_COMMAND: `update-shim ${digest}` },
    });
    assert.equal(shared.status, 1);
    assert.match(shared.stderr, /graphyard-host-shim refuses:/);
  } finally {
    if (saved === undefined) delete process.env.GRAPHYARD_CONFIG_HOME;
    else process.env.GRAPHYARD_CONFIG_HOME = saved;
  }
});
