import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimScript } from '../src/host-shim.js';
import { linkNativeLibraries, readRemoteShardRuns, readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { fixtureShim, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3932 AC-1: a merge trial places shards on a helper that speaks only run-shard:2 and on one that
// speaks run-shard:3, each in the form it accepts; a helper that refuses is marked away with its refusal;
// and the warm image the shards run in links embedded-postgres's native libraries, so Postgres starts there
// (after GY-3928 every shard on the test machines died on libicui18n.so.60).

const proof = 'integration:run-shard-version-negotiated';
const image = 'mainworks-trial:gy-3932';
const files = Array.from({ length: 6 }, (_, index) => `tests/case-${index + 1}.test.ts`);
const olderVerbs = 'probe:1 receive-pack:1 receive-image:3 prepare-run:2 run-shard:2 fetch-records:1 clean:1 run-session:1 update-shim:2 share:1';

/** The helper the test machines run today: run-shard:2, refusing any request key beyond files, argv, cpus and deadline. */
const olderShim = (root: string) => fixtureShim(hostShimScript, root)
  .replace(/^ {4}echo "shim [0-9a-f]{64}"$/m, `    echo "shim ${'a'.repeat(64)}"`)
  .replace(/^ {4}echo "verbs .*"$/m, `    echo "verbs ${olderVerbs}"`)
  .replace("<= set(request) <= {'files', 'argv', 'cpus', 'deadline', 'nonce'}", "== set(request)");
/** A helper that refuses every run-shard call. */
const refusingShim = (root: string) => fixtureShim(hostShimScript, root)
  .replace("if verb == 'run-shard':\n", "if verb == 'run-shard':\n            refuse()\n");

let hosts: ShardHostsFixture, repository: { root: string; sha: string }, executionsLog: string;
const commands: string[] = [];

before(async () => {
  hosts = await shardHosts('gy-3932-hosts', ['older', 'current', 'refusing'], { [image]: `sha256:${'3932'.repeat(16)}` });
  const shims = { older: olderShim(hosts.root), refusing: refusingShim(hosts.root) };
  assert.notEqual(shims.older, fixtureShim(hostShimScript, hosts.root));
  assert.notEqual(shims.refusing, fixtureShim(hostShimScript, hosts.root));
  for (const [name, text] of Object.entries(shims)) { await writeFile(join(hosts.root, `shim-${name}`), text); await chmod(join(hosts.root, `shim-${name}`), 0o755); }
  const ssh = await readFile(join(hosts.bin, 'ssh'), 'utf8');
  await writeFile(join(hosts.bin, 'ssh'), ssh.replace(/SSH_ORIGINAL_COMMAND="\$last" exec "([^"]+)"\n$/, (_, shim: string) =>
    `case "$host" in older|refusing) shim="${hosts.root}/shim-$host" ;; *) shim="${shim}" ;; esac\nSSH_ORIGINAL_COMMAND="$last" exec "$shim"\n`));
  executionsLog = join(hosts.root, 'executions.jsonl');
  const runner = `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const host = ['older', 'current'].find(name => process.cwd().includes('/hosts/' + name + '/')) ?? 'local';
for (const file of readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean)) {
  appendFileSync(${JSON.stringify(executionsLog)}, JSON.stringify({ file, host }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
  console.log('ok ' + file);
}
`;
  repository = await shardRepository('gy-3932-repo', files, { 'scripts/tests.mjs': runner, 'scripts/select.mjs': `console.log(${JSON.stringify(files.join('\n'))});\n` });
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});

const run: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'sh' && args[0] === '-c') commands.push(args[1]!);
  const env = { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` };
  if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, env, wrapper: undefined });
  return defaultChildRun(command, args, { ...options, env });
};

async function trialOn(target: string) {
  await rm(executionsLog, { force: true });
  const result = await runTrial({
    root: repository.root, base: await temporaryDirectory('gy-3932-base'), mergeSha: repository.sha, changedFiles: files,
    timeoutMs: 180_000, cores: 2, run, retries: 0, secretScan: false,
    remote: {
      hosts: [`gy-compute@${target}`],
      read: async (named, transport) => (await readShardHosts(named, run, 2, transport)).map((reading, index) =>
        ({ ...reading, cores: index === 0 ? 2 : reading.away ? 0 : 8, busy: index === 0 ? 2 : 0, steal: 0, celsius: null })),
    },
  });
  const executions = existsSync(executionsLog) ? (await readFile(executionsLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; host: string }) : [];
  const latest = readRemoteShardRuns(repository.root).at(-1)!;
  return { result, executions, latest, host: latest.hosts.find(entry => entry.name === `gy-compute@${target}`) };
}

test(`${proof} — shards run on a run-shard:2 helper and a run-shard:3 helper, a refusing helper is marked away with its refusal, and the warm image links Postgres's libraries`, { timeout: 240_000 }, async () => {
  for (const target of ['older', 'current']) {
    const { result, executions, latest, host } = await trialOn(target);
    assert.equal(result.build, 'pass', result.logTail);
    assert.deepEqual(result.tests.failed, [], result.logTail);
    assert.ok(latest.remote > 0, `${target} takes shards: ${JSON.stringify(latest)}`);
    assert.equal(host?.away, false, `${target} stays ready: ${JSON.stringify(host)}`);
    assert.ok(executions.some(entry => entry.host === target), `${target} ran files: ${JSON.stringify(executions)}`);
    assert.equal(executions.length, files.length, `no file runs twice: ${JSON.stringify(executions)}`);
  }

  const refused = await trialOn('refusing');
  assert.equal(refused.result.build, 'pass', refused.result.logTail);
  assert.deepEqual(refused.result.tests.failed, [], refused.result.logTail);
  assert.equal(refused.host?.away, true, JSON.stringify(refused.host));
  assert.match(refused.host?.reason ?? '', /graphyard-host-shim refuses: run-shard trial-\S+ \d+/);
  assert.ok(refused.executions.every(entry => entry.host === 'local') && refused.executions.length === files.length, JSON.stringify(refused.executions));

  // Every warm image install the trials ran links the native libraries after `npm ci --ignore-scripts`.
  const installs = commands.filter(command => command.includes('docker run') && command.includes('npm ci'));
  assert.ok(installs.length > 0, 'a warm image was built');
  for (const install of installs) assert.ok(install.indexOf('pg-symlinks.json') > install.indexOf('npm ci'), install);

  // The link step, run where npm installed, makes the versioned links Postgres loads.
  const deps = await temporaryDirectory('gy-3932-deps'), lib = join(deps, 'node_modules/@embedded-postgres/linux-x64/native/lib');
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, 'libicui18n.so.60.2'), '');
  await writeFile(join(lib, '..', 'pg-symlinks.json'), JSON.stringify([
    { source: 'native/lib/libicui18n.so.60.2', target: 'native/lib/libicui18n.so.60' },
    { source: 'native/lib/libicui18n.so.60.2', target: 'native/lib/libicui18n.so' },
  ]));
  execFileSync('sh', ['-c', linkNativeLibraries], { cwd: deps });
  assert.equal(await readlink(join(lib, 'libicui18n.so.60')), 'libicui18n.so.60.2');
  assert.ok(existsSync(join(lib, 'libicui18n.so')));
  execFileSync('sh', ['-c', linkNativeLibraries], { cwd: deps });
});
