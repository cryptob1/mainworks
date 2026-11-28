// GY-4002: a repository whose merge trial carries e2e cases, and fake test machines it can send them to.
// Each host runs the real graphyard-host-shim (or an older helper derived from it) over the stand-in
// Docker of shard-hosts.ts; a case's command step appends its id and its checkout's Git directory (a
// host's clone lives in that host's home) to `ranLog`, so a test sees where each case really ran.
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../../src/child-runner.js';
import { readRemoteShardRuns, readShardHosts } from '../../src/merge-writer/remote-shards.js';
import { trialHarness } from '../../src/merge-writer/trial-container.js';
import { runTrial } from '../../src/merge-writer/trial.js';
import type { HostReading } from '../../src/merge-writer/remote-shards.js';
import { patchEnv } from './env.js';
import { temporaryDirectory } from './temp-dirs.js';
import { buildPreGy3914Shim, shardHosts, shardRepository, type ShardHostsFixture } from './shard-hosts.js';

const repository = join(import.meta.dirname, '..', '..');
const tests = ['tests/unit.test.ts'];
const recordingCase = (id: string, ranLog: string, extra: Record<string, unknown> = {}, run = `node -e "require('fs').appendFileSync(process.argv[1], '${id} ' + require('path').resolve(String(require('child_process').execFileSync('git', ['rev-parse', '--git-common-dir'])).trim()) + '\\\\n')" ${ranLog}`) =>
  JSON.stringify({ id, title: `The ${id} case`, tags: ['api'], target: 'any', required: false, ...extra, steps: [{ kind: 'command', name: `record ${id}`, run, timeoutSeconds: 60 }] });

/** Hosts `helpers` (name to verbs line, or null for this release's helper) and a repository holding cases alpha, beta and gamma (whose step fails), delta (declaring a secret) and epsilon (naming an environment). */
export async function trialE2eHosts(label: string, helpers: Record<string, string | null>) {
  const image = `mainworks-trial:${label}`;
  const hosts: ShardHostsFixture = await shardHosts(label, Object.keys(helpers), { [image]: `sha256:${'4002'.repeat(16)}` });
  const ranLog = join(hosts.root, 'ran.log');
  const shims: Record<string, string> = {};
  for (const [name, verbs] of Object.entries(helpers)) {
    if (!verbs) continue;
    shims[name] = join(hosts.root, `shim-${name}`);
    await writeFile(shims[name]!, buildPreGy3914Shim(hosts.root, verbs, String(Object.keys(shims).length), !verbs.includes('prepare-run:2')));
    await chmod(shims[name]!, 0o755);
  }
  // Route each fake host to its own helper version.
  await writeFile(join(hosts.bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then exec /usr/bin/ssh "$@"; fi
for arg; do case "$arg" in -fNM|-O) exit 0;; esac; done
for last; do :; done
for arg; do case "$arg" in *@*) target="$arg";; esac; done
host="\${target#*@}"; dir="${hosts.root}/hosts/$host"
if [ ! -d "$dir" ] || [ -e "$dir.down" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
cd "$dir/home" && export HOME="$dir/home" PATH="$dir/bin:/usr/bin:/bin" GRAPHYARD_HOST_FLOOR_GB=0
case "$host" in
${Object.entries(shims).map(([name, shim]) => `  ${name}) shim="${shim}" ;;`).join('\n')}
  *) shim="${hosts.shim}" ;;
esac
SSH_ORIGINAL_COMMAND="$last" exec "$shim"
`);
  await chmod(join(hosts.bin, 'ssh'), 0o755);
  const port = 21000 + (process.pid % 20_000);
  const { root, sha } = await shardRepository(label, tests, {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { build: 'true' } }),
    'graphyard.json': JSON.stringify({
      e2e: { serve: { command: 'node serve.cjs', url: `http://127.0.0.1:${port}`, readySeconds: 20 } },
      delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node scripts/tests.mjs', source: 'script', reason: 'fixture', selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] } },
    }),
    'serve.cjs': `require('node:http').createServer((request, response) => response.end('{}')).listen(${port}, '127.0.0.1');\n`,
    'scripts/select.mjs': `console.log(${JSON.stringify(tests.join('\n'))});\n`,
    'e2e/cases/alpha.json': recordingCase('alpha', ranLog),
    'e2e/cases/beta.json': recordingCase('beta', ranLog),
    'e2e/cases/gamma.json': recordingCase('gamma', ranLog, {}, `node -e "require('fs').appendFileSync(process.argv[1], 'gamma ' + require('path').resolve(String(require('child_process').execFileSync('git', ['rev-parse', '--git-common-dir'])).trim()) + '\\\\n'); process.exit(3)" ${ranLog}`),
    'e2e/cases/delta.json': recordingCase('delta', ranLog, { secrets: ['FIXTURE_TOKEN'] }),
    'e2e/cases/epsilon.json': recordingCase('epsilon', ranLog, { environment: 'staging' }),
  });
  /** The trial's children: its local E2E runner against this checkout's harness, as e2e-host-start-failure does; the rest as the trial runs them, through the fake hosts' ssh and Docker. */
  const run: ChildRun = async (command, args, options) => {
    if (command === 'npm') return '';
    // This machine's own probe (sh) samples its real sensors without waiting between samples; its reading is overridden below.
    const probe = command === 'sh' ? { GRAPHYARD_PROBE_SAMPLE_SECONDS: '0' } : {};
    const env = { ...process.env, ...options?.env, ...probe, PATH: `${hosts.bin}:${process.env.PATH}` };
    const script = args.at(-1) ?? '';
    if (command === 'node' && script.endsWith('run.mjs')) {
      await writeFile(script, (await readFile(script, 'utf8')).replaceAll(trialHarness, repository));
      return defaultChildRun(command, ['--import', 'tsx', script], { ...options, env, cwd: repository, wrapper: undefined });
    }
    if (command === 'node' && args[0] === 'scripts/select.mjs') return tests.join('\n');
    return defaultChildRun(command, args, { ...options, env });
  };
  const restore = patchEnv({ GRAPHYARD_TRIAL_IMAGE: image, GRAPHYARD_STANDIN_NODE_MODULES: join(repository, 'node_modules'), PATH: `${hosts.bin}:${process.env.PATH}` });

  /** One merge trial of the repository's head with `proofs`, the hosts `targets` read with `adjust` applied (ready, 8 free cores and cool by default). */
  const trial = async (targets: string[], proofs: string[], adjust: (reading: HostReading) => Partial<HostReading> = () => ({})) => {
    await rm(ranLog, { force: true });
    const heatWaits: number[] = [];
    const result = await runTrial({
      root, base: await temporaryDirectory(`${label}-base`), mergeSha: sha, changedFiles: tests, timeoutMs: 240_000, cores: 2, run, retries: 0, secretScan: false,
      e2eProofs: proofs,
      remote: {
        hosts: targets,
        heatSleep: async ms => { heatWaits.push(ms); },
        read: async (named, transport) => (await readShardHosts(named, run, 2, transport)).map((reading, index) => index === 0
          ? { ...reading, cores: 2, busy: 2, steal: 0, celsius: null }
          : { ...reading, cores: 8, busy: 0, steal: 0, celsius: null, away: false, ...adjust(reading) }),
      },
    });
    const ran = existsSync(ranLog) ? (await readFile(ranLog, 'utf8')).split('\n').filter(Boolean).map(line => { const [id, cwd] = line.split(' '); return { id: id!, cwd: cwd! }; }) : [];
    /** Where case `id` ran: the fake host whose folder held its working directory, else here. */
    const where = (id: string) => ran.filter(entry => entry.id === id).map(entry => /\/hosts\/([^/]+)\//.exec(entry.cwd)?.[1] ?? 'here');
    return { result, ran, where, heatWaits, latest: readRemoteShardRuns(root).at(-1), root };
  };
  return { hosts, trial, restore, root };
}
