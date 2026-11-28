import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { batchGatePorts } from '../src/daemon/cycle-batch-gate.js';
import type { MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { catalogHosts, readShardHosts, remoteShardSession, type ShardSshSession } from '../src/merge-writer/remote-shards.js';
import type { MergeTrialRun } from '../src/merge-writer/executor.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3907: hello-huck's daily catalog failed on both test machines with ERR_MODULE_NOT_FOUND. A remote
// catalog shard ran `node --import tsx scripts/e2e-shard.mjs` in the project's checkout, which holds
// neither tsx nor that script: only Mainworks' own repository does. The shard now runs Mainworks'
// runner and loader from its image, as a local catalog run does, over the project's installed
// packages; and a shard that cannot resolve a module names the specifier in the filed failure.

const image = 'mainworks-trial:catalog-resolves';
const target = 'gy-compute@box';
// The local probe also takes five samples without sleeping on this machine.
const run: ChildRun = (command, args, options) => defaultChildRun(command, args, command === 'sh'
  ? { ...options, env: { ...process.env, ...options?.env, GRAPHYARD_PROBE_SAMPLE_SECONDS: '0' } } : options);
let sampleWaits: string;
let hosts: ShardHostsFixture, saved: Record<string, string | undefined>;

before(async () => {
  hosts = await shardHosts('remote-catalog-shard-resolves', ['box'], { [image]: `sha256:${'3907'.repeat(16)}` });
  // The fixture machine is ready even when the physical test machine is hot.
  const sensor = join(hosts.root, 'hwmon', 'hwmon0');
  await mkdir(sensor, { recursive: true });
  await writeFile(join(sensor, 'name'), 'coretemp\n');
  await writeFile(join(sensor, 'temp1_input'), '40000\n');
  // Keep all five real sensor reads, but record their half-second sleeps on a fake clock.
  sampleWaits = join(hosts.root, 'sample-waits.log');
  const sleep = join(hosts.root, 'hosts', 'box', 'bin', 'sleep');
  await writeFile(sleep, `#!/bin/sh\necho "$1" >> ${JSON.stringify(sampleWaits)}\n`);
  await chmod(sleep, 0o755);
  const config = await temporaryDirectory('remote-catalog-shard-config'), packages = await temporaryDirectory('remote-catalog-shard-packages');
  await mkdir(join(config, 'machine'), { recursive: true });
  await writeFile(join(config, 'machine', 'hosts.json'), JSON.stringify([{ target, addedAt: '2026-11-26T00:00:00.000Z' }]));
  // The project's installed packages: one dependency its case imports.
  await mkdir(join(packages, 'fixture-dep'), { recursive: true });
  await writeFile(join(packages, 'fixture-dep', 'package.json'), JSON.stringify({ name: 'fixture-dep', type: 'module', main: 'index.js' }));
  await writeFile(join(packages, 'fixture-dep', 'index.js'), "export default 'resolved';\n");
  saved = { PATH: process.env.PATH, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME, GRAPHYARD_TRIAL_IMAGE: process.env.GRAPHYARD_TRIAL_IMAGE, GRAPHYARD_STANDIN_NODE_MODULES: process.env.GRAPHYARD_STANDIN_NODE_MODULES };
  Object.assign(process.env, { PATH: `${hosts.bin}:${process.env.PATH}`, GRAPHYARD_CONFIG_HOME: config, GRAPHYARD_TRIAL_IMAGE: image, GRAPHYARD_STANDIN_NODE_MODULES: packages });
});
after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });

test('integration:remote-catalog-shard-resolves — a catalog shard on a test machine runs a case importing a project dependency and passes; a shard that cannot resolve a module names it in the filed failure', { timeout: 300_000 }, async t => {
  let last = performance.now();
  const step = (name: string) => { const now = performance.now(); t.diagnostic(`${name}: ${(now - last).toFixed(0)} ms`); last = now; };
  const readings = await readShardHosts([target], run, 2);
  assert.equal(readings[1]?.celsius, 40, `the fixture reads its own sensor: ${JSON.stringify(readings[1])}`);
  step('initial probe');
  const { root, sha } = await shardRepository('remote-catalog-shard-project', [], {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module' }),
    'graphyard.json': JSON.stringify({ delivery: { mode: 'local', applications: [{ id: 'site', kind: 'static', directory: 'site' }], cases: { 'uses-dependency': 'site' } } }),
    'site/index.html': '<h1>fixture</h1>\n',
    'e2e/cases/uses-dependency.json': JSON.stringify({ id: 'uses-dependency', title: 'The case imports a project dependency', tags: ['api'], target: 'any', required: false,
      steps: [{ kind: 'command', name: 'import the dependency', run: `node -e "import('fixture-dep').then(m => { if (m.default !== 'resolved') process.exit(1) })"`, timeoutSeconds: 60 }] }),
  });
  assert.equal(git(root, 'rev-parse', 'HEAD'), sha);

  step('repository');
  const sensor = join(hosts.root, 'hwmon', 'hwmon0', 'temp1_input');
  await writeFile(sensor, '99000\n');
  // Capacity is fixed: the fixture's temperature decides placement, not this machine's load.
  const read = async (named: readonly string[], transport: ShardSshSession) =>
    (await readShardHosts(named, run, 2, transport)).map((reading, index) =>
      index === 0 ? reading : { ...reading, cores: 24, busy: 0, steal: 0 });
  const rereadWaits: number[] = [];
  const hot = await catalogHosts({ heatSleep: async ms => { rereadWaits.push(ms); }, root, commit: sha, read, run, deadline: Date.now() + 240_000 });
  try { assert.deepEqual(hot.hosts, [], 'a hot fixture host takes no shards'); }
  finally { await hot.close(); }
  step('hot catalog and close');
  assert.deepEqual(rereadWaits, [10_000], 'hot host reread waits on the injected clock');
  await writeFile(sensor, '40000\n');
  const remote = await catalogHosts({ root, commit: sha, read, run, deadline: Date.now() + 240_000 });
  step('cool catalog');
  assert.deepEqual((await readFile(sampleWaits, 'utf8')).trim().split('\n'), Array(16).fill('0.5'),
    'initial, two hot and one cool probe keep all five sensor samples without real sleeps');
  try {
    assert.deepEqual(remote.hosts.map(host => host.name), [target], 'the test machine takes catalog shards');
    const ran = await remote.run(target, 1, ['e2e:uses-dependency']);
    step('remote case');
    assert.deepEqual(ran.map(entry => [entry.proof, entry.executed, entry.failed, entry.failingStep ?? null]), [['e2e:uses-dependency', 1, 0, null]],
      `the case passes on the test machine: ${JSON.stringify(ran)}`);
  } finally { await remote.close(); }

  step('remote close');
  // A shard whose loader names a package nobody installed: the day's filed failure names that specifier.
  const session = remoteShardSession({ root, sha, image, run, deadline: Date.now() + 120_000 });
  const reads = {
    baseBranch: 'main', now: Date.now, fetch: async () => sha,
    git: async (args: string[]) => args[0] === 'ls-tree' ? 'a.json\nb.json' : '',
    trial: async (_commit: string, files: readonly string[], item: { criteria: { proofs: string[] }[] }) => {
      const proofs = item.criteria.flatMap(criterion => criterion.proofs);
      return { build: 'pass', tests: { passed: 1, failed: [], files: files.length }, durationMs: 1, logTail: '', files: [], proofs: {},
        e2e: proofs.map(proof => ({ proof, case: proof.slice(4), executed: 1, failed: 0 })) } as unknown as MergeTrialRun;
    },
    gate: { root, repository: 'o/r', catalogHosts: async () => ({ hosts: [{ name: target, cores: 2, busy: 0, steal: 0, celsius: null, limit: 90, away: false }], close: () => session.close(),
      run: async (host: string, index: number, cases: readonly string[]) => {
        await session.run(host, index, cases.map(proof => `e2e/cases/${proof.slice(4)}.json`), () => ['node', '--import', 'not-installed-loader', '-e', '0'], 1);
        return [];
      } }) },
  } as unknown as MergeWriterReads;
  const result = await batchGatePorts({ ...reads, git: reads.git! }, []).diagnose(sha);
  step('missing loader diagnosis');
  assert.deepEqual(result.failed, ['e2e-catalog']);
  assert.match(result.details?.['e2e-catalog'] ?? '', /Cannot find package 'not-installed-loader'/, `the filed failure names the missing specifier: ${result.details?.['e2e-catalog']}`);
});
