import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import {
  ensureWarmImage,
  readShardHosts,
  remoteShardSession,
  warmCommitOnHosts,
  warmImageTag,
} from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { commitFile, dockerCount, dockerCreates, git, shardHosts, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3627 AC-1 & AC-2: the warm image is tagged with the lockfile hash and the main commit it was
// built from, holds that commit's dist/cli.mjs, dist/server.mjs and a filled compile cache that
// test processes are pointed at, is built at most once per verified commit and pushed to each ready
// compute host before a trial places a shard there. A trial whose base is newer than any image uses
// the newest one and rebuilds what differs; a head that changes a source file tests its own code;
// and the first start of the command line in a shard from the warm image uses under 0.6 CPU-seconds.

const source = fileURLToPath(new URL('..', import.meta.url));
const image = 'graphyard-trial:warm-head-fixture';
const digest = `sha256:${'3627'.repeat(16)}`;
const box = 'gy-compute@box';
let hosts: ShardHostsFixture;
const previousNodeModules = process.env.GRAPHYARD_STANDIN_NODE_MODULES;

before(async () => {
  hosts = await shardHosts('warm-image-serves-the-head', ['box'], { [image]: digest });
  process.env.GRAPHYARD_STANDIN_NODE_MODULES = join(source, 'node_modules');
});

after(() => {
  if (previousNodeModules === undefined) delete process.env.GRAPHYARD_STANDIN_NODE_MODULES;
  else process.env.GRAPHYARD_STANDIN_NODE_MODULES = previousNodeModules;
});

const runWithHosts: ChildRun = (command, args, options) =>
  defaultChildRun(command, args, {
    ...options,
    env: {
      ...process.env,
      ...options?.env,
      PATH: `${hosts.bin}:${process.env.PATH}`,
      GRAPHYARD_STANDIN_NODE_MODULES: join(source, 'node_modules'),
    },
  });

/** A small real git repository carrying the real Graphyard bin/, src/, package.json and package-lock.json. */
async function cliRepository(label: string) {
  const root = await temporaryDirectory(label);
  git(root, 'init', '-q', '-b', 'main');
  await cp(join(source, 'bin'), join(root, 'bin'), { recursive: true });
  await cp(join(source, 'src'), join(root, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(root, 'package.json'));
  await cp(join(source, 'package-lock.json'), join(root, 'package-lock.json'));
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'tests', 'cli.test.ts'), 'export {};\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  return { root, sha: git(root, 'rev-parse', 'HEAD') };
}

test('integration:warm-image-serves-the-head — warm image is keyed to lockfile and commit, pushed before shards, starts the CLI under 0.6 CPU-seconds, and a head changing a source file runs its own code in concurrent shards, two newest images kept, signals end the in-process CLI', { timeout: 240_000 }, async () => {
  const { root, sha: base } = await cliRepository('warm-image-repo');
  const lockHash = createHash('sha256').update((await readFile(join(root, 'package-lock.json'), 'utf8')).trim()).digest('hex');
  const expectedTag = warmImageTag(digest, lockHash, base);
  assert.match(expectedTag, /^graphyard-warm:362736273627-[0-9a-f]{12}-[0-9a-f]{12}$/, 'tag carries image digest, lockfile hash and commit');
  assert.ok(expectedTag.endsWith(`-${base.slice(0, 12)}`), `tag ${expectedTag} ends with base commit ${base.slice(0, 12)}`);

  // 1. Release check verifies `base`: warm image is built once and pushed to each ready compute host.
  const firstWarm = await warmCommitOnHosts({
    root,
    commit: base,
    image,
    hosts: [box],
    read: async (named, transport) => (await readShardHosts(named, runWithHosts, 2, transport)).map((reading, index) => ({ ...reading, cores: index ? 8 : 2, busy: 0, steal: 0, celsius: null, away: false })),
    run: runWithHosts,
    deadline: Date.now() + 120_000,
  });
  assert.equal(firstWarm.tag, expectedTag);
  assert.equal(firstWarm.built, true);
  assert.deepEqual(firstWarm.pushed, [box], 'ready compute host received the warm image before any trial');
  assert.equal(dockerCount(hosts.localState, 'commit'), 1, 'warm image built once');
  assert.equal(dockerCount(hosts.state('box'), 'load'), 1, 'warm image loaded once on the ready host');

  // Building again for the same verified commit is a no-op (at most once per verified commit).
  const again = await ensureWarmImage({ root, commit: base, image, run: runWithHosts, deadline: Date.now() + 60_000 });
  assert.equal(again.tag, expectedTag);
  assert.equal(again.built, false);
  assert.equal(dockerCount(hosts.localState, 'commit'), 1, 'still built at most once per verified commit');

  // 2. A shard on `base` uses the warm image already on the host: dist/cli.mjs, dist/server.mjs and
  //    a filled NODE_COMPILE_CACHE are present, and the first start of the CLI uses under 0.6 CPU-seconds.
  const baseSession = remoteShardSession({ root, sha: base, baseTip: base, image, run: runWithHosts, deadline: Date.now() + 120_000 });
  const measureScript = `
    import { existsSync, readdirSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    const records = process.argv[1];
    const cacheDir = process.env.NODE_COMPILE_CACHE || '';
    const cacheEntries = cacheDir && existsSync(cacheDir) ? readdirSync(cacheDir, { recursive: true }).length : 0;
    const hasCli = existsSync('dist/cli.mjs');
    const hasServer = existsSync('dist/server.mjs');
    const raw = execFileSync('/bin/sh', ['-c', '"$0" bin/graphyard.mjs --help >"$1" && times', process.execPath, 'help.out'], { encoding: 'utf8' });
    const [user, system] = [...raw.trim().split('\\n')[1].matchAll(/(\\d+)m([\\d.]+)s/g)].map(([, m, s]) => Number(m) * 60 + Number(s));
    const cpu = user + system;
    const help = execFileSync('cat', ['help.out'], { encoding: 'utf8' });
    console.log(JSON.stringify({ cacheDir, cacheEntries, hasCli, hasServer, cpu, hasUsage: /^Usage: /m.test(help) }));
    writeFileSync(records, JSON.stringify({ file: 'tests/cli.test.ts', passed: true, durationMs: 1 }) + '\\n');
  `;
  try {
    const baseShard = await baseSession.run(box, 0, ['tests/cli.test.ts'], (_list, records) => [process.execPath, '--input-type=module', '-e', measureScript, records], 2);
    assert.equal(baseShard.ok, true, baseShard.out);
    assert.equal(dockerCount(hosts.state('box'), 'load'), 1, 'host already held the warm image: no load on trial start');
    const parsed = JSON.parse(baseShard.out.trim().split('\n').at(-1)!) as {
      cacheDir: string; cacheEntries: number; hasCli: boolean; hasServer: boolean; cpu: number; hasUsage: boolean;
    };
    assert.equal(parsed.hasCli, true, 'dist/cli.mjs is present in the shard');
    assert.equal(parsed.hasServer, true, 'dist/server.mjs is present in the shard');
    assert.ok(parsed.cacheDir.length > 0 && parsed.cacheEntries > 0, `NODE_COMPILE_CACHE points to a filled compile cache directory: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.hasUsage, true, 'CLI printed usage');
    assert.ok(parsed.cpu < 0.6, `first start of the CLI from the warm image took ${parsed.cpu.toFixed(3)} CPU-seconds (limit: 0.6)`);
  } finally {
    await baseSession.close();
  }

  // 3. A newer base commit (no warm image built for it yet) + a head that changes one source file:
  //    the trial reuses the newest warm image (`base`'s), rebuilds what differs, and tests the head's own code.
  const base2 = await commitFile(root, 'tests/cli.test.ts', '// newer base\nexport {};\n');
  const cliPath = join(root, 'src', 'cli', 'index.ts');
  const originalCli = await readFile(cliPath, 'utf8');
  const marker = 'WARM-IMAGE-HEAD-BEHAVIOUR-GY-3627';
  const modifiedCli = originalCli.replace('distributed work, explicit proof', `distributed work, explicit proof ${marker}`);
  assert.notEqual(modifiedCli, originalCli, 'src/cli/index.ts contains the banner to modify');
  const head = await commitFile(root, 'src/cli/index.ts', modifiedCli);

  const headSession = remoteShardSession({ root, sha: head, baseTip: base2, image, run: runWithHosts, deadline: Date.now() + 120_000 });
  // AC-3(b): two shards of the trial start at once on the same host. Each records dist/cli.mjs and dist/server.mjs when it starts
  // and again after a pause: neither sees it change, so no shard wrote rebuilt files while another ran.
  const verifyHeadScript = `
    import { execFileSync } from 'node:child_process';
    import { statSync, writeFileSync } from 'node:fs';
    const records = process.argv[1];
    const seen = () => ['cli', 'server'].map(name => { const { ino, mtimeMs } = statSync('dist/' + name + '.mjs'); return ino + ':' + mtimeMs; }).join(',');
    const before = seen();
    const help = execFileSync(process.execPath, ['bin/graphyard.mjs', '--help'], { encoding: 'utf8' });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const hasMarker = help.includes(${JSON.stringify(marker)});
    console.log('HEAD_SEEN=' + hasMarker);
    console.log('DIST=' + before + '>' + seen());
    writeFileSync(records, JSON.stringify({ file: 'tests/cli.test.ts', passed: hasMarker, durationMs: 1 }) + '\\n');
    if (!hasMarker) process.exit(1);
  `;
  try {
    const shards = await Promise.all([0, 1].map(index => headSession.run(box, index, ['tests/cli.test.ts'], (_list, records) => [process.execPath, '--input-type=module', '-e', verifyHeadScript, records], 2)));
    const dist = shards.map(shard => {
      assert.equal(shard.ok, true, shard.out);
      assert.match(shard.out, /HEAD_SEEN=true/, shard.out);
      const [start, end] = /DIST=(\S+)>(\S+)/.exec(shard.out)!.slice(1);
      assert.equal(end, start, `dist/ changed while a shard ran: ${shard.out}`);
      return start;
    });
    assert.equal(dist[1], dist[0], 'both shards read the one rebuilt dist/');
    assert.equal(dockerCount(hosts.localState, 'commit'), 1, 'newer base reused the newest existing warm image without rebuilding a new image');
    assert.equal(dockerCount(hosts.state('box'), 'load'), 1, 'no new warm image needed to be loaded on the host');
    const creates = await dockerCreates(hosts.state('box'));
    assert.equal(creates.at(-1)![creates.at(-1)!.indexOf('--entrypoint') + 2], expectedTag, 'the head shard ran in the newest existing warm image');
  } finally {
    await headSession.close();
  }

  // AC-3(a): three successive verified commits leave the two newest warm images of this trial image and lockfile, here and on the host.
  const family = warmImageTag(digest, lockHash);
  const warmImages = async (state: string) => Object.keys(JSON.parse(await readFile(join(state, 'state.json'), 'utf8')).images).filter(name => name.startsWith(`${family}-`)).sort();
  const verified = [base];
  for (const label of ['third', 'fourth']) {
    const commit = await commitFile(root, 'tests/cli.test.ts', `// ${label} base\nexport {};\n`);
    const warmed = await warmCommitOnHosts({
      root, commit, image, hosts: [box], run: runWithHosts, deadline: Date.now() + 120_000,
      read: async (named, transport) => (await readShardHosts(named, runWithHosts, 2, transport)).map((reading, index) => ({ ...reading, cores: index ? 8 : 2, busy: 0, steal: 0, celsius: null, away: false })),
    });
    assert.deepEqual(warmed.pushed, [box]);
    verified.push(commit);
  }
  const newest = verified.slice(-2).map(commit => warmImageTag(digest, lockHash, commit)).sort();
  assert.deepEqual(await warmImages(hosts.localState), newest, 'this machine keeps the two newest warm images');
  assert.deepEqual(await warmImages(hosts.state('box')), newest, 'the compute host keeps the two newest warm images');

  // AC-3(c): on the launcher's in-process path (a built CLI and NODE_COMPILE_CACHE set), SIGINT and SIGTERM still end the command.
  const launcher = await temporaryDirectory('warm-image-signals');
  await mkdir(join(launcher, 'bin'), { recursive: true }); await mkdir(join(launcher, 'src')); await mkdir(join(launcher, 'dist'));
  for (const file of ['graphyard.mjs', 'mainworks.mjs']) await cp(join(source, 'bin', file), join(launcher, 'bin', file));
  await writeFile(join(launcher, 'src', 'cli.ts'), '');
  await writeFile(join(launcher, 'bin', 'built-entry.mjs'), "import { join } from 'node:path';\nexport const builtEntry = (root, name) => join(root, 'dist', `${name}.mjs`);\n");
  await writeFile(join(launcher, 'dist', 'cli.mjs'), "console.log('waiting'); setInterval(() => {}, 1000);\n");
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const child = spawn(process.execPath, [join(launcher, 'bin', 'graphyard.mjs')], { env: { ...process.env, NODE_COMPILE_CACHE: join(launcher, 'cache') }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>(resolve => child.stdout!.on('data', chunk => { if (String(chunk).includes('waiting')) resolve(); }));
    child.kill(signal);
    const ended = await Promise.race([once(child, 'exit').then(([code, by]) => by ?? code), new Promise(resolve => setTimeout(() => resolve('still running'), 5_000))]);
    if (ended === 'still running') child.kill('SIGKILL');
    assert.equal(ended, signal, `${signal} ends the in-process command`);
  }
});
