import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import type { ChildRun } from '../src/child-runner.js';
import { addHost, readHostReadings, readHosts } from '../src/hosts.js';
import { outdatedShimAttention } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withEnv } from './helpers/env.js';

// GY-3836 AC-2: The older-helper attention line and `host add`'s no-terminal message name a login
// target: the USER@HOST the machine was added with when recorded, otherwise the HostName the
// compute alias resolves to with the current user, never the alias that points at the helper's port.
// Covers a host recorded as gy-compute@NAME-compute whose alias resolves to NAME port 2222.

const proof = 'unit:older-helper-hint-names-the-login-host';

const olderProbeOutput = [
  `shim ${'1'.repeat(64)}`,
  'verbs probe:1 receive-pack:1 receive-image:1 prepare-run:1 run-shard:2 fetch-records:1 clean:1',
  'user 1001 gy-compute',
  'compose 5.6.1',
  'cores 8',
  'load 0.50',
  'cpu 100 0 100 800 0 0 0 0 0 0',
  'runs 0',
].join('\n');

test(`${proof} — older record gy-compute@NAME-compute resolves alias HostName with current user, never the compute alias`, async () => {
  const dir = await temporaryDirectory('older-helper-alias');
  const file = join(dir, 'hosts.json');
  const alias = 'gy-compute@omarchypc-compute';
  await writeFile(file, JSON.stringify([{ target: alias, addedAt: '2026-11-20T00:00:00.000Z' }]));

  const run: ChildRun = async (command, args) => {
    if (command === 'sh') return olderProbeOutput;
    if (command === 'ssh' && args.includes('-G')) {
      const target = args.at(-1) ?? '';
      if (target.includes('omarchypc-compute')) return 'user gy-compute\nhostname omarchypc\nport 2222\n';
      return `user ${userInfo().username}\nhostname ${target.replace(/^.*@/, '')}\nport 22\n`;
    }
    if (command === 'ssh') return olderProbeOutput;
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const readings = await readHostReadings([], { file, knownHosts: join(dir, 'known_hosts'), run, local: 'here' });
  const remote = readings.find(reading => reading.host === alias)!;
  assert.equal(remote.away, false);
  assert.equal(remote.older, true);

  const [line] = outdatedShimAttention([remote]);
  const expected = `mainworks host add ${userInfo().username}@omarchypc in a terminal`;
  assert.ok(line, 'older helper raises an attention line');
  assert.ok(line.text.includes(expected), `expected "${expected}" in text: ${line.text}`);
  assert.ok(line.next.includes(expected), `expected "${expected}" in next: ${line.next}`);
  assert.doesNotMatch(line.text, /@omarchypc-compute in a terminal/, 'never names the compute alias as the login target');
  assert.doesNotMatch(line.next, /@omarchypc-compute/, 'never names the compute alias in next');
});

test(`${proof} — recorded login USER@HOST is preferred over current user, and host add no-terminal message never names the helper-port alias`, async () => {
  const dir = await temporaryDirectory('older-helper-recorded');
  const file = join(dir, 'hosts.json');
  const alias = 'gy-compute@omarchypc-compute';
  await writeFile(file, JSON.stringify([{ target: alias, addedAt: '2026-11-20T00:00:00.000Z', login: 'alice@omarchypc' }]));

  const run: ChildRun = async (command, args) => {
    if (command === 'sh') return olderProbeOutput;
    if (command === 'ssh' && args.includes('-G')) {
      const target = args.at(-1) ?? '';
      if (target.includes('omarchypc-compute')) return 'user vish\nhostname omarchypc\nport 2222\n';
      return 'user vish\nhostname omarchypc\nport 22\n';
    }
    if (command === 'ssh') throw Object.assign(new Error('unreachable'), { status: 255 });
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  // 1. Attention line uses the recorded login (alice@omarchypc).
  const readings = await readHostReadings([], {
    file,
    knownHosts: join(dir, 'known_hosts'),
    run: async (command, args) => (command === 'ssh' && !args.includes('-G') ? olderProbeOutput : run(command, args)),
    local: 'here',
  });
  const [line] = outdatedShimAttention(readings.filter(r => !r.local));
  assert.ok(line!.text.includes('mainworks host add alice@omarchypc in a terminal'), line!.text);
  assert.ok(line!.next.includes('mainworks host add alice@omarchypc in a terminal'), line!.next);

  // 2. host add without a terminal on vish@omarchypc-compute (resolving to omarchypc:2222) prints
  // the login target (never the helper-port alias).
  await assert.rejects(
    addHost('vish@omarchypc-compute', { file: join(dir, 'empty-hosts.json'), knownHosts: join(dir, 'known_hosts'), run, terminal: false }),
    (error: Error) => {
      assert.equal(error.message, 'Run this in a terminal: mainworks host add vish@omarchypc');
      return true;
    },
  );

  // 3. With a recorded login for that host, host add without a terminal uses the recorded login.
  await assert.rejects(
    addHost('vish@omarchypc-compute', { file, knownHosts: join(dir, 'known_hosts'), run, terminal: false }),
    (error: Error) => {
      assert.equal(error.message, 'Run this in a terminal: mainworks host add alice@omarchypc');
      return true;
    },
  );

  // 4. Direct ssh -G fallback in outdatedShimAttention (without probe.login) using a real ~/.ssh/config.
  const sshHome = join(dir, 'home');
  await mkdir(join(sshHome, '.ssh'), { recursive: true });
  await writeFile(
    join(sshHome, '.ssh', 'config'),
    'Host alpha-compute\n  HostName alpha\n  Port 2222\n  User gy-compute\n',
    { mode: 0o600 },
  );
  withEnv({ HOME: sshHome }, () => {
    const [direct] = outdatedShimAttention([{ host: 'gy-compute@alpha-compute', away: false, older: true }]);
    assert.ok(
      direct!.text.includes(`mainworks host add ${userInfo().username}@alpha in a terminal`),
      `real ssh -G resolves alpha-compute to alpha: ${direct!.text}`,
    );
    assert.doesNotMatch(direct!.next, /alpha-compute/);
  });

  // Verify readHosts preserves login field.
  const hosts = await readHosts(file);
  assert.equal(hosts[0]?.login, 'alice@omarchypc');
});
