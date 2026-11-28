import { test } from 'node:test';
import { patchEnv, withEnv } from './helpers/env.js';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHeadlessWorker } from '../src/headless-session.js';
import { clearRuns } from '../src/runner/registry.js';
import { supervise } from '../src/session-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-4034 AC-4: an opencode builder launched through session-watch, fresh or continued, receives
// its message and starts its run instead of printing `opencode run` help and exiting — even when
// the coordinator's opencode supports `--standalone` while the remote container's opencode (1.19.6)
// rejects `--standalone` — with and without MAINWORKS_RESERVED_CPUS set.
const proof = 'integration:opencode-builder-starts-with-reserved-cpus';
const repo = fileURLToPath(new URL('..', import.meta.url));
const tsx = createRequire(join(repo, 'package.json')).resolve('tsx');

const cpus = (list: string) => list.trim().split(',').flatMap(part => {
  const [first, last = first] = part.split('-').map(Number) as [number, number?];
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
});
const online = () => readFileSync('/sys/devices/system/cpu/online', 'utf8').trim();
const reserved = `0-${Math.max(0, Math.min(3, cpus(online()).length - 3))}`;
const others = () => cpus(online()).filter(cpu => !cpus(reserved).includes(cpu));
const allowedByKernel = (status: string | undefined) => status?.split('\t')[1]?.trim() ?? '';

const withReserved = <T>(value: string | undefined, body: () => Promise<T>) => withEnv({ MAINWORKS_RESERVED_CPUS: value }, body);

/** Coordinator opencode (2.x): advertises and accepts --standalone. */
const localOpencode = `#!/bin/sh
set -eu
for a in "$@"; do
  if [ "$a" = --help ]; then
    echo "opencode run [message..]"
    echo "  --standalone  run with a private server"
    exit 0
  fi
done
msg=""
for a in "$@"; do msg="$a"; done
printf 'LOCAL_MSG=%s\\n' "$msg"
grep Cpus_allowed_list /proc/self/status
`;

/** Remote container opencode (1.19.6): lacks --standalone and prints `opencode run` help on unknown flag or missing message. */
const remoteOpencode = `#!/bin/sh
set -eu
for a in "$@"; do
  if [ "$a" = --help ]; then
    echo "opencode run [message..]"
    exit 0
  fi
  if [ "$a" = --standalone ]; then
    echo "opencode run [message..]" >&2
    echo "" >&2
    echo "run opencode with a message" >&2
    exit 1
  fi
done
if [ "\${1:-}" != run ]; then
  echo "opencode run [message..]" >&2
  exit 1
fi
shift
session=""
msg=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --format) shift 2 ;;
    --session|-s) session="$2"; shift 2 ;;
    -*) echo "opencode run [message..]" >&2; exit 1 ;;
    *) msg="$1"; shift ;;
  esac
done
if [ -z "$msg" ]; then
  echo "opencode run [message..]" >&2
  exit 1
fi
printf 'REMOTE_SESSION=%s REMOTE_MSG=%s\\n' "$session" "$msg"
`;

const renewal = () => ({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + 20_000).toISOString() } });

test(`${proof} — remote and local opencode builders (fresh and continued) through session-watch start with and without reserved CPUs`, { timeout: 120_000 }, async () => {
  const image = 'graphyard-trial:gy4034-opencode';
  const target = 'gy-compute@buildhost';
  const hosts = await shardHosts('gy4034-opencode', ['buildhost'], { [image]: `sha256:${'d403'.repeat(16)}` });
  const repository = await shardRepository('gy4034-opencode-repo', [], { 'bin/opencode': remoteOpencode });
  git(repository.root, 'update-index', '--chmod=+x', 'bin/opencode');
  git(repository.root, 'commit', '-qm', 'remote opencode');
  git(repository.root, 'config', 'user.name', 'Worker');
  git(repository.root, 'config', 'user.email', 'worker@example.com');
  const worktree = join(await temporaryDirectory('gy4034-opencode-worktrees'), 'GY-4034-1');
  git(repository.root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-4034-1', worktree);
  const loopRoot = await temporaryDirectory('gy4034-opencode-loop');
  const account = await temporaryDirectory('gy4034-opencode-account');
  await mkdir(join(account, 'opencode'), { recursive: true });
  await writeFile(join(account, 'opencode', 'auth.json'), '{"zai":{"type":"api","key":"test"}}', { mode: 0o600 });
  const localBin = await temporaryDirectory('gy4034-local-opencode');
  await writeFile(join(localBin, 'opencode'), localOpencode, { mode: 0o755 });
  await chmod(join(localBin, 'opencode'), 0o755);
  const tools = await temporaryDirectory('gy4034-opencode-cli');
  const fakeCli = join(tools, 'bin', 'graphyard.mjs');
  await mkdir(join(tools, 'bin'));
  await writeFile(fakeCli, 'console.log("ok");\n');

  // Wrapper around fixture ssh that records the supervised process's Cpus_allowed_list.
  const shimBin = await temporaryDirectory('gy4034-opencode-ssh');
  const realSsh = join(hosts.bin, 'ssh');
  await writeFile(join(shimBin, 'ssh'), `#!/bin/sh
case "$*" in *"run-session "*) grep Cpus_allowed_list /proc/self/status >&2 ;; esac
exec ${JSON.stringify(realSsh)} "$@"
`, { mode: 0o755 });
  await chmod(join(shimBin, 'ssh'), 0o755);

  // Coordinator PATH sees localOpencode (2.x with --standalone); remote container PATH sees worktree/bin/opencode (1.19.6 without --standalone).
  const coordinatorPath = `${shimBin}:${hosts.bin}:${localBin}:${dirname(process.execPath)}:${process.env.PATH}`;
  const remotePath = `${worktree}/bin:${dirname(process.execPath)}:${process.env.PATH}`;
  const restoreEnv = patchEnv({ PATH: coordinatorPath, GRAPHYARD_TRIAL_IMAGE: image });
  const previousCwd = process.cwd();
  try {
    process.chdir(worktree);
    process.env.GRAPHYARD_TRIAL_IMAGE = image;

    const remoteWords = [process.execPath, '--import', tsx, join(repo, 'src', 'cli.ts'), 'host', 'session', target,
      '--home', account, '--env', 'PATH', '--env', 'XDG_DATA_HOME', '--cli', fakeCli, '--'];

    for (const setting of [reserved, undefined] as const) {
      await withReserved(setting, async () => {
        // Fresh and continued remote opencode runs launched through startHeadlessWorker -> supervise.
        for (const session of [null, 'ses_prev'] as const) {
          let stdout = '', stderr = '';
          const started = await startHeadlessWorker({
            name: 'worker-opencode', work: 'GY-4034', subject: 'GY-4034: opencode', epoch: 1,
            principal: 'worker-opencode', account: null, kind: 'opencode', args: ['--standalone'],
            environment: { PATH: coordinatorPath, GRAPHYARD_TRIAL_IMAGE: image, XDG_DATA_HOME: account },
            directory: worktree, supervisor: [], prompt: 'Implement GY-4034.', session, freshPrompt: 'Fresh GY-4034.',
            root: loopRoot, timeoutMs: 60_000, startupMs: 60_000, remote: { host: target, words: remoteWords },
            exec: async (command, args, options) => {
              // Inside the remote container, PATH resolves worktree/bin/opencode (1.19.6 without --standalone).
              const log = join(options.run, 'log.jsonl');
              // host session reads process.env[name] for each --env NAME; set PATH so shimBin/hosts.bin win for ssh AND worktree/bin wins for opencode inside the container.
              const code = await withEnv({ PATH: `${shimBin}:${hosts.bin}:${remotePath}` }, () =>
                supervise(command, args, 1, async () => renewal(), { intervalMs: 200, graceMs: 75, log, worktree }));
              const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { stream: string; text: string });
              stdout = lines.filter(line => line.stream === 'stdout').map(line => line.text).join('\n');
              stderr = lines.filter(line => line.stream === 'stderr').map(line => line.text).join('\n');
              if (code !== 0) throw Object.assign(new Error(`exit ${code}: ${stderr}`), { output: `${stdout}\n${stderr}` });
              return stdout;
            },
          });
          assert.equal(started.ended?.ok, true, `remote opencode (session=${session}, reserved=${setting ?? 'none'}) failed: ${stderr}`);
          assert.match(stdout, /REMOTE_MSG=.*Implement GY-4034\./, `remote opencode did not receive its message: ${stdout}`);
          if (session) assert.match(stdout, /REMOTE_SESSION=ses_prev/, `continued opencode did not receive --session: ${stdout}`);
          const localKernel = allowedByKernel(stderr.split('\n').find(line => line.includes('Cpus_allowed_list')));
          if (setting) assert.deepEqual(cpus(localKernel), others());
          else {
            const inherited = allowedByKernel(readFileSync('/proc/self/status', 'utf8').match(/Cpus_allowed_list.*/)?.[0]);
            assert.deepEqual(cpus(localKernel), cpus(inherited));
          }
        }
      });
    }
  } finally {
    clearRuns();
    process.chdir(previousCwd);
    restoreEnv();
  }
});
