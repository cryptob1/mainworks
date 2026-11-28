import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { catalogHosts, readShardHosts, type HostReading, type ShardSshSession } from '../src/merge-writer/remote-shards.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-4111: every diagnostics run filed green cases red from the test machines. A remote catalog shard
// made its worktree under the container's /tmp, a tmpfs, so the GY-88 managed worktree root check
// refused every checkout there; and cases that need the confined runtime sandbox ran on hosts where
// it does not work. The shard now works under its run directory on the host's disk, the host probe
// says whether the sandbox works there, and a case tagged `sandbox` runs only on such a host, else here.

const image = 'mainworks-trial:off-tmpfs';
const tmpfsHost = 'gy-compute@tmpfs', plainHost = 'gy-compute@plain';
const run: ChildRun = (command, args, options) => defaultChildRun(command, args, command === 'sh'
  ? { ...options, env: { ...process.env, ...options?.env, GRAPHYARD_PROBE_SAMPLE_SECONDS: '0' } } : options);
let hosts: ShardHostsFixture, saved: Record<string, string | undefined>;

before(async () => {
  hosts = await shardHosts('remote-shard-checkout-off-tmpfs', ['tmpfs', 'plain'], { [image]: `sha256:${'4111'.repeat(16)}` });
  // `tmpfs`: the container's temporary directory is a tmpfs, as a test machine's shard container's /tmp is;
  // its stand-in `unshare` lets the probe through, as the sandbox works there.
  await mkdir(hosts.state('tmpfs'), { recursive: true });
  await writeFile(join(hosts.state('tmpfs'), 'tmpfs-tmp'), '');
  await writeFile(join(hosts.root, 'hosts', 'tmpfs', 'bin', 'unshare'), '#!/bin/sh\ncase " $* " in *" -Urm "*) exit 0;; esac\nexec /usr/bin/unshare "$@"\n', { mode: 0o755 });
  // `plain`: the kernel refuses an unprivileged user and mount namespace, so the sandbox cannot start there.
  await writeFile(join(hosts.root, 'hosts', 'plain', 'bin', 'unshare'), '#!/bin/sh\ncase " $* " in *" -Urm "*) echo "unshare: Operation not permitted" >&2; exit 1;; esac\nexec /usr/bin/unshare "$@"\n', { mode: 0o755 });
  // Both fixture hosts read one cool sensor, whatever this machine's heat.
  const sensor = join(hosts.root, 'hwmon', 'hwmon0');
  await mkdir(sensor, { recursive: true });
  await writeFile(join(sensor, 'name'), 'coretemp\n'); await writeFile(join(sensor, 'temp1_input'), '40000\n');
  const config = await temporaryDirectory('remote-shard-off-tmpfs-config');
  await mkdir(join(config, 'machine'), { recursive: true });
  await writeFile(join(config, 'machine', 'hosts.json'), JSON.stringify([tmpfsHost, plainHost].map(target => ({ target, addedAt: '2026-11-27T00:00:00.000Z' }))));
  saved = { PATH: process.env.PATH, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME, GRAPHYARD_TRIAL_IMAGE: process.env.GRAPHYARD_TRIAL_IMAGE };
  Object.assign(process.env, { PATH: `${hosts.bin}:${process.env.PATH}`, GRAPHYARD_CONFIG_HOME: config, GRAPHYARD_TRIAL_IMAGE: image });
});
after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

/** A catalog of the two cases, read as the diagnostics read it; the local lane only records what it ran. */
const diagnostics = (sha: string, readings: readonly HostReading[], local: string[], placed: Record<string, string[]>) => ({
  baseBranch: 'main', now: Date.now, fetch: async () => sha,
  git: async (args: string[]) => args[0] === 'ls-tree' ? 'on-disk.json\nneeds-sandbox.json'
    : args[1]?.endsWith(':e2e/cases/needs-sandbox.json') ? JSON.stringify({ id: 'needs-sandbox', tags: ['sandbox'], steps: [{ kind: 'command', run: 'true' }] }) : '',
  trial: async (_commit: string, files: readonly string[], item: { criteria: { proofs: string[] }[] }) => {
    const proofs = item.criteria.flatMap(criterion => criterion.proofs);
    local.push(...proofs);
    return { build: 'pass', tests: { passed: 1, failed: [], files: files.length }, durationMs: 1, logTail: '', files: [], proofs: {},
      e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
  },
  gate: { root: '/nowhere', repository: 'o/r', catalogHosts: async () => ({ hosts: [...readings], close: async () => {},
    run: async (host: string, _index: number, cases: readonly string[]) => {
      (placed[host] ??= []).push(...cases);
      return cases.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 }));
    } }) },
}) as unknown as MergeWriterReads;

test('integration:remote-shard-checkout-off-tmpfs — a remote catalog shard checks out on the host\'s disk, not its tmpfs /tmp, and a case needing the sandbox runs only on a host whose probe says it works there, else on this machine', { timeout: 300_000 }, async () => {
  const { root, sha } = await shardRepository('remote-shard-off-tmpfs-project', [], {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module' }),
    'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { 'on-disk': 'site' } } }),
    'site/index.html': '<h1>fixture</h1>\n',
    // The GY-88 check refuses a managed root on a tmpfs; this case refuses a checkout on one the same way.
    'e2e/cases/on-disk.json': JSON.stringify({ id: 'on-disk', title: 'The shard checks out on durable storage', tags: ['api'], target: 'any', required: false,
      steps: [{ kind: 'command', name: 'the checkout is on disk', run: `node -e "if (require('node:fs').statfsSync(process.cwd()).type === 0x01021994) { console.error('checkout on tmpfs: ' + process.cwd()); process.exit(1) }"`, timeoutSeconds: 60 }] }),
  });
  const read = async (named: readonly string[], transport: ShardSshSession) =>
    (await readShardHosts(named, run, 2, transport)).map((reading, index) => index === 0 ? reading : { ...reading, cores: 24, busy: 0, steal: 0 });
  const remote = await catalogHosts({ root, commit: sha, read, run, deadline: Date.now() + 240_000 });
  let readings: HostReading[];
  try {
    readings = remote.hosts;
    assert.deepEqual(readings.map(host => [host.name, host.sandbox === true]), [[tmpfsHost, true], [plainHost, false]],
      `the probe says where the sandbox works: ${JSON.stringify(readings)}`);
    const ran = await remote.run(tmpfsHost, 1, ['e2e:on-disk']);
    assert.deepEqual(ran.map(entry => [entry.proof, entry.executed, entry.failed, entry.failingStep ?? null]), [['e2e:on-disk', 1, 0, null]],
      `the case passes on the host whose /tmp is a tmpfs: ${JSON.stringify(ran)}`);
  } finally { await remote.close(); }

  // Both hosts ready: the sandbox case goes to the host where the sandbox works, never the other.
  const local: string[] = [], placed: Record<string, string[]> = {};
  const both = await batchGatePorts({ ...diagnostics(sha, readings, local, placed), git: diagnostics(sha, readings, local, placed).git! }, []).diagnose(sha);
  assert.deepEqual(both.failed, []);
  assert.ok(placed[tmpfsHost]?.includes('e2e:needs-sandbox'), `the sandbox case runs on the host where it works: ${JSON.stringify(placed)}`);
  assert.ok(!placed[plainHost]?.includes('e2e:needs-sandbox'), 'never on the host without it');
  assert.deepEqual(local, [], 'this machine runs neither case');

  // Only the host without the sandbox ready: the sandbox case runs on this machine.
  const alone: string[] = [], elsewhere: Record<string, string[]> = {};
  const plain = readings.filter(host => host.name === plainHost);
  await batchGatePorts({ ...diagnostics(sha, plain, alone, elsewhere), git: diagnostics(sha, plain, alone, elsewhere).git! }, []).diagnose(sha);
  assert.deepEqual(alone, ['e2e:needs-sandbox'], 'the sandbox case runs here');
  assert.deepEqual(elsewhere, { [plainHost]: ['e2e:on-disk'] }, 'the host without the sandbox runs only the other case');
});
