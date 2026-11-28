import { test } from 'node:test';
import { patchEnv } from './helpers/env.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { addHost, hostKnownHostsFile, hostsFile, probeHost, readHostReadings } from '../src/hosts.js';
import { hostShimDigest, trialVerbs } from '../src/host-shim.js';
import { readShardHosts, remoteShardSession, shardSshSession } from '../src/merge-writer/remote-shards.js';
import { masterCredentialMask } from '../src/master/confinement.js';
import { masterSessionConfinement } from '../src/master/launch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3698 AC-1: host add, host list probes and the loop's shard connections all use one known-hosts
// file under the install's machine folder with StrictHostKeyChecking=accept-new: a first add
// records the key, a later changed key is refused with one line naming the host and the file to
// edit, and host add succeeds with no ~/.ssh present.

const probeAnswer = [
  `shim ${hostShimDigest}`,
  `verbs ${trialVerbs.join(' ')}`,
  'cores 8',
  'load 0.50',
  'runs 0',
  'user 1001 gy-compute',
  'cpu 100 0 0 900 0 0 0 0',
].join('\n') + '\n';

function optionValue(args: readonly string[], key: string): string | null {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-o' && args[i + 1]!.startsWith(`${key}=`)) return args[i + 1]!.slice(key.length + 1);
  }
  return null;
}

test('unit:host-add-records-key-in-machine-folder — host add, host list probes and shard connections share machine/known_hosts with accept-new, work with no ~/.ssh, and refuse a changed key in one line', async t => {
  const root = await temporaryDirectory('host-known-hosts');
  const config = join(root, 'config');
  const home = join(root, 'empty-home');
  await mkdir(home, { recursive: true });
  // Guarantee there is no ~/.ssh at all.
  await rm(join(home, '.ssh'), { recursive: true, force: true });
  assert.equal(existsSync(join(home, '.ssh')), false);

  patchEnv({ HOME: home, GRAPHYARD_CONFIG_HOME: config }, t);

  const expectedKnownHosts = join(config, 'machine', 'known_hosts');
  assert.equal(hostKnownHostsFile(), expectedKnownHosts);

  const calls: { program: string; args: string[]; configText?: string }[] = [];
  let hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFirstKey';

  const run: ChildRun = async (program, args) => {
    if (program !== 'ssh') return '';
    const record: { program: string; args: string[]; configText?: string } = { program, args: [...args] };
    const fIndex = args.indexOf('-F');
    if (fIndex >= 0 && args[fIndex + 1] && existsSync(args[fIndex + 1]!)) {
      record.configText = await readFile(args[fIndex + 1]!, 'utf8');
    }
    calls.push(record);

    if (args.includes('-G')) {
      return 'hostname 100.88.105.12\nuser gy-compute\nport 2222\nuserknownhostsfile ~/.ssh/known_hosts\nstricthostkeychecking ask\n';
    }
    if (args.includes('-fNM') || args.includes('-O')) {
      // Simulate OpenSSH verifying/recording the host key via the -F config.
      const kh = /^UserKnownHostsFile\s+(.+)$/mi.exec(record.configText ?? '')?.[1]?.trim();
      const strict = /^StrictHostKeyChecking\s+(.+)$/mi.exec(record.configText ?? '')?.[1]?.trim();
      if (!kh || strict !== 'accept-new') {
        throw Object.assign(new Error('Host key verification failed.'), { status: 255, stderr: 'Host key verification failed.\n' });
      }
      return '';
    }

    // Direct ssh calls (host add, probeHost, readHostReadings, operatorLogin):
    const kh = optionValue(args, 'UserKnownHostsFile') ?? /^UserKnownHostsFile\s+(.+)$/mi.exec(record.configText ?? '')?.[1]?.trim() ?? null;
    const strict = optionValue(args, 'StrictHostKeyChecking') ?? /^StrictHostKeyChecking\s+(.+)$/mi.exec(record.configText ?? '')?.[1]?.trim() ?? null;
    if (!kh || strict !== 'accept-new') {
      throw Object.assign(new Error('Host key verification failed.'), { status: 255, stderr: 'Host key verification failed.\n' });
    }

    const existing = await readFile(kh, 'utf8').catch(() => '');
    const entry = `[100.88.105.12]:2222 ${hostKey}`;
    if (!existing.trim()) {
      await writeFile(kh, `${entry}\n`, { mode: 0o600 });
    } else if (!existing.includes(entry)) {
      const stderr = [
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
        '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
        '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
        `Offending ED25519 key in ${kh}:1`,
        'Host key for [100.88.105.12]:2222 has changed and you have requested strict checking.',
        'Host key verification failed.',
      ].join('\n') + '\n';
      throw Object.assign(new Error('Host key verification failed.'), { status: 255, stderr });
    }

    const verb = args.at(-1) ?? '';
    if (verb === 'probe') return probeAnswer;
    if (verb === 'echo mainworks-plain-shell') throw Object.assign(new Error('unknown verb'), { status: 1, stderr: 'unknown verb\n' });
    if (verb === 'true') throw Object.assign(new Error('Permission denied'), { status: 255, stderr: 'Permission denied\n' });
    return '';
  };

  // 1. First host add with no ~/.ssh succeeds and records the key in <config>/machine/known_hosts.
  const added = await addHost('gy-compute@100.88.105.12:2222', { run });
    assert.equal(added.added, true);
    assert.equal(existsSync(join(home, '.ssh')), false, 'no ~/.ssh was needed or created');
    assert.equal((await readFile(expectedKnownHosts, 'utf8')).trim(), `[100.88.105.12]:2222 ${hostKey}`);
    const addConnectCalls = calls.filter(c => !c.args.includes('-G'));
    assert.ok(addConnectCalls.length >= 2, 'addHost made ssh calls for plain-shell check and probe');
    for (const call of addConnectCalls) {
      assert.equal(optionValue(call.args, 'UserKnownHostsFile'), expectedKnownHosts, `addHost ssh call uses machine known_hosts: ${call.args.join(' ')}`);
      assert.equal(optionValue(call.args, 'StrictHostKeyChecking'), 'accept-new', `addHost ssh call uses accept-new: ${call.args.join(' ')}`);
    }

    // 2. Host list probes (readHostReadings / probeHost) use the same known-hosts file and accept-new.
    calls.length = 0;
    const readings = await readHostReadings([], { run, local: 'here' });
    assert.equal(readings[1]?.away, false);
    assert.equal(calls.length, 1);
    assert.equal(optionValue(calls[0]!.args, 'UserKnownHostsFile'), expectedKnownHosts);
    assert.equal(optionValue(calls[0]!.args, 'StrictHostKeyChecking'), 'accept-new');

    // 3. The loop's shard connections (shardSshSession / readShardHosts / remoteShardSession) use the same file.
    calls.length = 0;
    const transport = shardSshSession(run);
    const session = remoteShardSession({ root, sha: 'a'.repeat(40), image: 'img', run, deadline: Date.now() + 60_000, transport });
    try {
      const shardReadings = await readShardHosts(['gy-compute@100.88.105.12:2222'], run, 4, transport);
      assert.equal(shardReadings[1]?.away, false);
    } finally {
      await session.close();
    }
    const shardConnects = calls.filter(c => c.args.includes('-F') && !c.args.includes('-G'));
    assert.ok(shardConnects.length >= 2, 'shard session opened and used a connection with -F config');
    for (const call of shardConnects) {
      assert.match(call.configText ?? '', new RegExp(`^UserKnownHostsFile ${expectedKnownHosts.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      assert.match(call.configText ?? '', /^StrictHostKeyChecking accept-new$/m);
      assert.doesNotMatch(call.configText ?? '', /^userknownhostsfile ~\/\.ssh/mi, 'default ~/.ssh/known_hosts is not copied from ssh -G');
      assert.doesNotMatch(call.configText ?? '', /^stricthostkeychecking ask$/mi, 'default ask is not copied from ssh -G');
    }

    // 4. A later changed host key is refused with ONE line naming the host and the file to edit.
    hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIChangedKey';
    await writeFile(hostsFile(config), '[]\n');
    await assert.rejects(
      addHost('gy-compute@100.88.105.12:2222', { run }),
      (error: Error) => {
        assert.ok(!error.message.includes('\n'), `changed-key refusal is one line, got: ${JSON.stringify(error.message)}`);
        assert.ok(error.message.includes('gy-compute@100.88.105.12:2222'), `names the host: ${error.message}`);
        assert.ok(error.message.includes(expectedKnownHosts), `names the known_hosts file to edit: ${error.message}`);
        return true;
      },
    );
    const changedProbe = await probeHost('gy-compute@100.88.105.12:2222', run);
    assert.equal(changedProbe.ok, false);
    if (!changedProbe.ok) {
      assert.ok(!changedProbe.reason.includes('\n'), `probe refusal is one line: ${JSON.stringify(changedProbe.reason)}`);
      assert.ok(changedProbe.reason.includes('gy-compute@100.88.105.12:2222'));
      assert.ok(changedProbe.reason.includes(expectedKnownHosts));
    }

    // 5. Master confinement profile grants only the machine known_hosts (and hosts.json) file writable, not the whole machine folder.
    const repo = join(root, 'repo');
    await mkdir(join(repo, '.git', 'objects'), { recursive: true });
    await mkdir(join(repo, '.git', 'refs', 'heads'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const installDir = join(config, 'own-install');
    await mkdir(join(installDir, 'masters'), { recursive: true });
    const token = join(installDir, 'masters', 'master.token');
    await writeFile(token, 't'.repeat(40), { mode: 0o600 });
    await writeFile(join(config, 'machine', 'tailnet.json'), '{"ip":"100.64.0.1"}\n');

    const mask = masterCredentialMask({ credentialFile: token }, [], config);
    const confinement = await masterSessionConfinement('claude', repo, { bwrap: 'bwrap', platform: 'linux', mountNamespaceWorks: true }, [join(installDir, 'masters')], { GRAPHYARD_CONFIG_HOME: config }, mask);
    const words = confinement.wrapper;
    const machineDir = join(config, 'machine');
    const maskedAt = words.findIndex((w, i) => w === '--tmpfs' && words[i + 1] === machineDir);
    const knownHostsBind = words.findIndex((w, i) => w === '--bind' && words[i + 1] === expectedKnownHosts && words[i + 2] === expectedKnownHosts);
    const hostsJsonBind = words.findIndex((w, i) => w === '--bind' && words[i + 1] === hostsFile(config) && words[i + 2] === hostsFile(config));
    assert.ok(maskedAt > 0, 'the machine folder itself stays masked');
    assert.ok(knownHostsBind > maskedAt, 'known_hosts is bound writable after the mask');
    assert.ok(hostsJsonBind > maskedAt, 'hosts.json is bound writable after the mask');
    assert.equal(words.findIndex((w, i) => w === '--bind' && words[i + 1] === machineDir), -1, 'the machine folder itself is never bound writable');
    const setenvConfig = words.findIndex((w, i) => w === '--setenv' && words[i + 1] === 'GRAPHYARD_CONFIG_HOME' && words[i + 2] === config);
    assert.ok(setenvConfig > 0, 'GRAPHYARD_CONFIG_HOME is passed into the confined master session');
    // Regular files must not be passed to Landlock's directory-only REFER rule list.
    const landlockArg = words[words.indexOf('-c') + 2];
    const [landlockDirs] = JSON.parse(landlockArg!) as [string[], string[]];
    assert.ok(!landlockDirs.includes(expectedKnownHosts), 'known_hosts file is not passed to Landlock directory rules');
    assert.ok(!landlockDirs.includes(hostsFile(config)), 'hosts.json file is not passed to Landlock directory rules');
});
