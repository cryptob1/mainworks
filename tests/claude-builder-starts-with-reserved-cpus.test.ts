import { test } from 'node:test';
import { patchEnv, withEnv } from './helpers/env.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { supervise, systemdContainment } from '../src/session-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCreates, git, shardHosts, shardRepository } from './helpers/shard-hosts.js';

// GY-4034: a Claude builder launched through session-watch (both locally and on a remote compute
// host via `host session`) starts and reads its `--settings` harness file with MAINWORKS_RESERVED_CPUS
// set and without, while keeping GY-4006's AllowedCPUs / Cpus_allowed_list off the reserved CPUs.
const proof = 'integration:claude-builder-starts-with-reserved-cpus';
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

/** Stand-in claude: exits 1 with Claude's own message if its --settings file is unreadable; prints its settings marker and Cpus_allowed_list. */
const standInClaude = `#!/bin/sh
set -eu
settings=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --settings) settings="$2"; shift 2 ;;
    --settings=*) settings="\${1#--settings=}"; shift ;;
    *) shift ;;
  esac
done
if [ -z "$settings" ] || [ ! -r "$settings" ]; then
  printf 'Error: Settings file not found: %s\\n' "$settings" >&2
  exit 1
fi
printf 'SETTINGS=%s\\n' "$(cat "$settings")"
grep Cpus_allowed_list /proc/self/status
`;

const renewal = () => ({ updatedAt: new Date().toISOString(), lease: { epoch: 1, expiresAt: new Date(Date.now() + 20_000).toISOString() } });

test(`${proof} — local claude builder through session-watch reads its --settings file and keeps reserved-CPU affinity`, async () => {
  const base = await temporaryDirectory('gy4034-local');
  const claude = join(base, 'claude');
  const settingsFile = join(base, '.graphyard', 'harness', 'worker-claude.json');
  await mkdir(dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, '{"permissions":{"allow":["Bash(git status)"]}}', { mode: 0o600 });
  await writeFile(claude, standInClaude, { mode: 0o755 });
  await chmod(claude, 0o755);

  for (const setting of [reserved, undefined] as const) {
    await withReserved(setting, async () => {
      const log = join(base, `run-${setting ?? 'none'}.jsonl`);
      const code = await supervise(claude, ['--setting-sources', 'user', '--settings', settingsFile, '-p', 'hi'], 1, async () => renewal(), { intervalMs: 200, graceMs: 75, log });
      const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { stream: string; text: string });
      const stdout = lines.filter(line => line.stream === 'stdout').map(line => line.text);
      const stderr = lines.filter(line => line.stream === 'stderr').map(line => line.text).join('\n');
      assert.equal(code, 0, `stand-in claude exited ${code}: ${stderr}`);
      assert.ok(stdout.some(line => line.includes('Bash(git status)')), `claude did not read its settings file: ${stdout.join('\n')}`);
      const kernel = allowedByKernel(stdout.find(line => line.includes('Cpus_allowed_list')));
      if (setting) {
        assert.deepEqual(cpus(kernel), others(), `claude process ran on ${kernel}, expected ${others().join(',')}`);
        const scope = systemdContainment(claude, ['--settings', settingsFile], (() => '') as unknown as typeof execFileSync);
        const prop = scope.args.find(word => word.startsWith('AllowedCPUs='));
        assert.ok(prop, `no AllowedCPUs in ${JSON.stringify(scope.args)}`);
        assert.deepEqual(cpus(prop.slice('AllowedCPUs='.length)), others());
      } else {
        const inherited = allowedByKernel(readFileSync('/proc/self/status', 'utf8').match(/Cpus_allowed_list.*/)?.[0]);
        assert.deepEqual(cpus(kernel), cpus(inherited));
      }
    });
  }
});

test(`${proof} — remote claude builder through session-watch hands over its --settings file and keeps reserved-CPU affinity`, { timeout: 120_000 }, async () => {
  const image = 'graphyard-trial:gy4034';
  const target = 'gy-compute@buildhost';
  const hosts = await shardHosts('gy4034-remote', ['buildhost'], { [image]: `sha256:${'c403'.repeat(16)}` });
  const repository = await shardRepository('gy4034-repo', [], { 'bin/claude': standInClaude });
  git(repository.root, 'update-index', '--chmod=+x', 'bin/claude');
  git(repository.root, 'commit', '-qm', 'stand-in claude');
  git(repository.root, 'config', 'user.name', 'Worker');
  git(repository.root, 'config', 'user.email', 'worker@example.com');
  const worktree = join(await temporaryDirectory('gy4034-worktrees'), 'GY-4034-1');
  git(repository.root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-4034-1', worktree);
  const account = await temporaryDirectory('gy4034-account');
  await writeFile(join(account, '.credentials.json'), '{"claudeAiOauth":{}}', { mode: 0o600 });
  const tools = await temporaryDirectory('gy4034-cli');
  const fakeCli = join(tools, 'bin', 'graphyard.mjs');
  await mkdir(join(tools, 'bin'));
  await writeFile(fakeCli, 'console.log("ok");\n');

  // Wrapper in front of the fixture ssh that hides the coordinator's harness file once run-session
  // begins, modelling a remote host container that does not share the coordinator's filesystem.
  const shimBin = await temporaryDirectory('gy4034-ssh-wrap');
  const realSsh = join(hosts.bin, 'ssh');
  await writeFile(join(shimBin, 'ssh'), `#!/bin/sh
case "$*" in
  *"run-session "*)
    grep Cpus_allowed_list /proc/self/status >&2
    if [ -n "\${GY4034_HIDE_SETTINGS:-}" ]; then rm -f "$GY4034_HIDE_SETTINGS"; fi
    ;;
esac
exec ${JSON.stringify(realSsh)} "$@"
`, { mode: 0o755 });
  await chmod(join(shimBin, 'ssh'), 0o755);

  const harnessDir = join(await temporaryDirectory('gy4034-harness'), '.graphyard', 'harness');
  await mkdir(harnessDir, { recursive: true });

  const restoreEnv = patchEnv({
    PATH: `${shimBin}:${hosts.bin}:${worktree}/bin:${dirname(process.execPath)}:${process.env.PATH}`,
    GRAPHYARD_TRIAL_IMAGE: image,
    GY4034_HIDE_SETTINGS: process.env.GY4034_HIDE_SETTINGS,
  });
  const previousCwd = process.cwd();
  try {
    process.chdir(worktree);

    for (const setting of [reserved, undefined] as const) {
      await withReserved(setting, async () => {
        const settingsFile = join(harnessDir, `worker-claude-${setting ? 'reserved' : 'plain'}.json`);
        const content = '{"permissions":{"allow":["Bash(git status)"]}}';
        await writeFile(settingsFile, content, { mode: 0o600 });
        process.env.GY4034_HIDE_SETTINGS = settingsFile;

        const log = join(tools, `remote-${setting ?? 'none'}.jsonl`);
        const beforeCreates = (await dockerCreates(hosts.state('buildhost'))).length;
        const code = await supervise(
          process.execPath,
          ['--import', tsx, join(repo, 'src', 'cli.ts'), 'host', 'session', target,
            '--home', account, '--env', 'PATH', '--cli', fakeCli, '--',
            'claude', '--setting-sources', 'user', '--settings', settingsFile, '-p', 'hi'],
          1,
          async () => renewal(),
          { intervalMs: 200, graceMs: 75, log, worktree },
        );
        const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { stream: string; text: string });
        const stdout = lines.filter(line => line.stream === 'stdout').map(line => line.text);
        const stderr = lines.filter(line => line.stream === 'stderr').map(line => line.text);
        assert.equal(code, 0, `remote claude exited ${code}: ${stderr.join('\n')}`);
        assert.ok(stdout.some(line => line.includes('Bash(git status)')), `remote claude did not read its settings file: ${stdout.join('\n')}`);

        const created = (await dockerCreates(hosts.state('buildhost'))).slice(beforeCreates).find(words => words.some(word => word.startsWith('mainworks-session-')));
        assert.ok(created, 'remote session container was created');
        assert.ok(created.some((word, index) => word === '--tmpfs' && created[index + 1]?.startsWith(`${harnessDir}:`)), `harness directory ${harnessDir} was not mounted as tmpfs in ${JSON.stringify(created)}`);

        const localKernel = allowedByKernel(stderr.find(line => line.includes('Cpus_allowed_list')));
        if (setting) {
          assert.deepEqual(cpus(localKernel), others(), `supervised remote launcher ran on ${localKernel}, expected ${others().join(',')}`);
        } else {
          const inherited = allowedByKernel(readFileSync('/proc/self/status', 'utf8').match(/Cpus_allowed_list.*/)?.[0]);
          assert.deepEqual(cpus(localKernel), cpus(inherited));
        }
      });
    }
  } finally {
    process.chdir(previousCwd);
    restoreEnv();
  }
});
