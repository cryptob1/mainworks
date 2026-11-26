import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimScript } from '../src/host-shim.js';
import { readRemoteShardRuns, readShardHosts } from '../src/merge-writer/remote-shards.js';
import { runTrial } from '../src/merge-writer/trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { fixtureShim, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3928 AC-1: a merge trial places test shards on ready compute hosts running both helper
// versions installed on the live machines today (one with update-shim:2 and receive-image:3,
// one with the oldest verb set — both on run-shard:2 without nonce support), accepts their
// results, runs no shard both remotely and locally, and keeps GY-3914's nonce protection for
// hosts that support it.

const proof = 'integration:trial-uses-ready-hosts-of-both-helper-versions';
const image = 'mainworks-trial:gy-3928-helpers';
const files = Array.from({ length: 6 }, (_, index) => `tests/case-${index + 1}.test.ts`);

const liveModernVerbs = 'probe:1 receive-pack:1 receive-image:3 prepare-run:2 run-shard:2 fetch-records:1 clean:1 run-session:1 update-shim:2 share:1';
const liveOldestVerbs = 'probe:1 receive-pack:1 receive-image:1 prepare-run:1 run-shard:2 fetch-records:1 clean:1';

/**
 * Derive a faithful pre-GY-3914 helper script from the current shim:
 * - prints the given pre-GY-3914 verbs line (with run-shard:2) and a non-current digest
 * - enforces pre-GY-3914 strict `set(request) != {'files', 'argv', 'cpus', 'deadline'}` (refusing `nonce`)
 * - optionally enforces pre-GY-3627 2-part warm image tags (oldest helper)
 */
function buildPreGy3914Shim(root: string, verbs: string, digestChar: string, v1ImageOnly: boolean): string {
  let script = fixtureShim(hostShimScript, root);
  script = script.replace(/^    echo "shim [0-9a-f]{64}"$/m, `    echo "shim ${digestChar.repeat(64)}"`);
  script = script.replace(/^    echo "verbs .*"$/m, `    echo "verbs ${verbs}"`);
  script = script.replace(
    /if verb == 'run-shard':\n            if not isinstance\(request, dict\) or not \(\{'files', 'argv', 'cpus', 'deadline'\} <= set\(request\) <= \{'files', 'argv', 'cpus', 'deadline', 'nonce'\}\):\n                refuse\(\)\n        elif not isinstance\(request, dict\) or set\(request\) != \{'file', 'services', 'argv', 'cpus', 'deadline'\}:/,
    "if not isinstance(request, dict) or set(request) != ({'files', 'argv', 'cpus', 'deadline'} if verb == 'run-shard' else {'file', 'services', 'argv', 'cpus', 'deadline'}):",
  );
  if (v1ImageOnly) {
    script = script.replace(
      /warm_image = r'\^graphyard-warm:\[0-9a-f\]\{12\}-\(\?:\\?\[0-9a-f\]\{12\}\|none\)\(\?:-\[0-9a-f\]\{12\}\)\?\$'/,
      "warm_image = r'^graphyard-warm:[0-9a-f]{12}-(?:[0-9a-f]{12}|none)$'",
    );
    script = script.replace(
      /\^graphyard-warm:\[0-9a-f\]\{12\}-\(\?:\[0-9a-f\]\{12\}\|none\)\(\?:-\[0-9a-f\]\{12\}\)\?\$/,
      '^graphyard-warm:[0-9a-f]{12}-(?:[0-9a-f]{12}|none)$',
    );
  }
  return script;
}

let hosts: ShardHostsFixture;
let repository: { root: string; sha: string };
let executionsLog: string;
const previousImage = process.env.GRAPHYARD_TRIAL_IMAGE;

before(async () => {
  hosts = await shardHosts('gy-3928-helpers', ['modern', 'oldest', 'current'], { [image]: `sha256:${'9b9b'.repeat(16)}` });
  const modernShim = join(hosts.root, 'shim-modern');
  const oldestShim = join(hosts.root, 'shim-oldest');
  await writeFile(modernShim, buildPreGy3914Shim(hosts.root, liveModernVerbs, 'a', false));
  await writeFile(oldestShim, buildPreGy3914Shim(hosts.root, liveOldestVerbs, 'b', true));
  await chmod(modernShim, 0o755);
  await chmod(oldestShim, 0o755);

  // Route each fake host to its own helper script version.
  await writeFile(join(hosts.bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then exec /usr/bin/ssh "$@"; fi
for arg; do case "$arg" in -fNM|-O) exit 0;; esac; done
for last; do :; done
for arg; do case "$arg" in *@*) target="$arg";; esac; done
host="\${target#*@}"; dir="${hosts.root}/hosts/$host"
if [ ! -d "$dir" ] || [ -e "$dir.down" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
cd "$dir/home" && export HOME="$dir/home" PATH="$dir/bin:/usr/bin:/bin" GRAPHYARD_HOST_FLOOR_GB=0
case "$host" in
  modern) shim="${modernShim}" ;;
  oldest) shim="${oldestShim}" ;;
  *) shim="${hosts.shim}" ;;
esac
SSH_ORIGINAL_COMMAND="$last" exec "$shim"
`);
  await chmod(join(hosts.bin, 'ssh'), 0o755);

  executionsLog = join(hosts.root, 'executions.jsonl');
  const runner = `import { readFileSync, appendFileSync } from 'node:fs';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const cwd = process.cwd();
const host = cwd.includes('/hosts/modern/') ? 'modern'
  : cwd.includes('/hosts/oldest/') ? 'oldest'
  : cwd.includes('/hosts/current/') ? 'current'
  : 'local';
const files = readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean);
for (const file of files) {
  appendFileSync(${JSON.stringify(executionsLog)}, JSON.stringify({ file, host }) + '\\n');
  appendFileSync(at('--durations'), JSON.stringify({ file, passed: true, durationMs: 1 }) + '\\n');
  console.log('ok ' + file + ' on ' + host);
}
`;
  repository = await shardRepository('gy-3928-repo', files, {
    'scripts/tests.mjs': runner,
    'scripts/select.mjs': `console.log(${JSON.stringify(files.join('\n'))});\n`,
  });
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});

after(() => {
  if (previousImage === undefined) delete process.env.GRAPHYARD_TRIAL_IMAGE;
  else process.env.GRAPHYARD_TRIAL_IMAGE = previousImage;
});

const runWithHosts: ChildRun = async (command, args, options) => {
  if (command === 'npm') return '';
  if (command === 'node' && args[0] === 'scripts/select.mjs') return files.join('\n');
  const env = { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` };
  if (command === 'node' && args[0] === 'scripts/tests.mjs') return defaultChildRun(command, args, { ...options, env, wrapper: undefined });
  return defaultChildRun(command, args, { ...options, env });
};

async function runTrialAgainst(targets: string[]) {
  await rm(executionsLog, { force: true });
  const timings: string[] = [];
  const result = await runTrial({
    root: repository.root,
    base: await temporaryDirectory('gy-3928-trial-base'),
    mergeSha: repository.sha,
    changedFiles: files,
    timeoutMs: 180_000,
    cores: 2,
    run: runWithHosts,
    retries: 0,
    secretScan: false,
    onTiming: step => timings.push(step),
    remote: {
      hosts: targets,
      read: async (named, transport) => (await readShardHosts(named, runWithHosts, 2, transport)).map((reading, index) => ({
        ...reading,
        cores: index === 0 ? 2 : (reading.away ? 0 : 8),
        busy: index === 0 ? 2 : 0,
        steal: 0,
        celsius: null,
      })),
    },
  });
  const executions = existsSync(executionsLog)
    ? (await readFile(executionsLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; host: string })
    : [];
  const latest = readRemoteShardRuns(repository.root).at(-1);
  return { result, executions, timings, latest };
}

test(`${proof} — trial places shards on ready hosts running update-shim:2/receive-image:3 (run-shard:2) and the oldest verb set, accepts results, and runs no shard twice`, { timeout: 180_000 }, async () => {
  // 1. Live modern-older helper (update-shim:2, receive-image:3, run-shard:2 — vish-msi-compute).
  const modernRun = await runTrialAgainst(['gy-compute@modern']);
  assert.equal(modernRun.result.build, 'pass', modernRun.result.logTail);
  assert.deepEqual(
    { passed: modernRun.result.tests.passed, failed: modernRun.result.tests.failed },
    { passed: files.length, failed: [] },
    modernRun.result.logTail,
  );
  assert.ok((modernRun.latest?.remote ?? 0) > 0, `modern helper must receive remote shards: ${JSON.stringify(modernRun.latest)}`);
  assert.ok(modernRun.executions.some(entry => entry.host === 'modern'), `expected executions on modern host: ${JSON.stringify(modernRun.executions)}`);
  assert.equal(modernRun.executions.length, files.length, `no shard may run both remotely and locally: ${JSON.stringify(modernRun.executions)}`);
  assert.equal(new Set(modernRun.executions.map(entry => entry.file)).size, files.length);
  assert.equal(modernRun.latest?.hosts.find(host => host.name === 'gy-compute@modern')?.away, false, `modern host must not be dropped: ${JSON.stringify(modernRun.latest?.hosts)}`);

  // 2. Live oldest helper (receive-image:1, prepare-run:1, run-shard:2 — omarchypc-compute).
  const oldestRun = await runTrialAgainst(['gy-compute@oldest']);
  assert.equal(oldestRun.result.build, 'pass', oldestRun.result.logTail);
  assert.deepEqual(
    { passed: oldestRun.result.tests.passed, failed: oldestRun.result.tests.failed },
    { passed: files.length, failed: [] },
    oldestRun.result.logTail,
  );
  assert.ok((oldestRun.latest?.remote ?? 0) > 0, `oldest helper must receive remote shards: ${JSON.stringify(oldestRun.latest)}`);
  assert.ok(oldestRun.executions.some(entry => entry.host === 'oldest'), `expected executions on oldest host: ${JSON.stringify(oldestRun.executions)}`);
  assert.equal(oldestRun.executions.length, files.length, `no shard may run both remotely and locally: ${JSON.stringify(oldestRun.executions)}`);
  assert.equal(new Set(oldestRun.executions.map(entry => entry.file)).size, files.length);
  assert.equal(oldestRun.latest?.hosts.find(host => host.name === 'gy-compute@oldest')?.away, false, `oldest host must not be dropped: ${JSON.stringify(oldestRun.latest?.hosts)}`);

  // 3. Current helper (run-shard:3) still receives shards and keeps GY-3914 nonce verification.
  const currentRun = await runTrialAgainst(['gy-compute@current']);
  assert.equal(currentRun.result.build, 'pass', currentRun.result.logTail);
  assert.ok((currentRun.latest?.remote ?? 0) > 0, `current helper must receive remote shards: ${JSON.stringify(currentRun.latest)}`);
  assert.equal(currentRun.executions.length, files.length, `no duplicate run on current helper: ${JSON.stringify(currentRun.executions)}`);
  assert.equal(currentRun.latest?.hosts.find(host => host.name === 'gy-compute@current')?.away, false);
});
