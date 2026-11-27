import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { setHostSessions } from '../src/hosts.js';
import { remoteRuntimes, remoteSessionHost, runRemoteSession } from '../src/remote-session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCreates, git, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-4004 AC-1: every runtime the install's builders use runs on an added host. The worker image's trial
// stage installs each one remoteRuntimes lists. Per runtime, the dispatch's placement picks the host,
// whatever the runtime, and the session runs there under the real graphyard-host-shim (Docker the
// fixture's read-only-root stand-in, whose --tmpfs is memory): a stand-in runtime at the runtime's own
// program name reads its login where that runtime does, commits, and refreshes the login. No file on
// the host holds the login during or after, and the refreshed login comes back here.

const proof = 'integration:every-worker-runtime-runs-on-a-host';
const image = 'graphyard-trial:every-runtime';
const target = 'gy-compute@buildhost';
const repo = fileURLToPath(new URL('..', import.meta.url));
/** Each runtime: the program its one-task form runs, its login-home variables, and the login file it reads there. */
const runtimes = [
  { kind: 'claude', program: 'claude', variables: ['CLAUDE_CONFIG_DIR'], login: '.credentials.json', installs: '@anthropic-ai/claude-code@' },
  { kind: 'codex', program: 'codex', variables: ['CODEX_HOME'], login: 'auth.json', installs: '@openai/codex@' },
  { kind: 'opencode', program: 'opencode', variables: ['XDG_DATA_HOME'], login: 'opencode/auth.json', installs: 'opencode-ai@' },
  { kind: 'cursor', program: 'cursor-agent', variables: ['CURSOR_CONFIG_DIR', 'XDG_CONFIG_HOME'], login: 'cursor/auth.json', installs: '/usr/local/bin/cursor-agent' },
];
const standIn = (kind: string, variable: string, login: string) => `#!/bin/sh
set -e
printf '%s' "$(cat "$${variable}/${login}")" | sha256sum | cut -d' ' -f1 > ${kind}.txt
git add ${kind}.txt && git commit -qm "${kind} work on the host"
printf 'refreshed-${kind}' > "$${variable}/${login}"
`;
/** The fixture host's probe reads this machine's own cores and load; placement here is judged by runtime, so it reads an idle, cool host (load is integration:builders-stay-within-host-share's). */
const idle: ChildRun = async (command, args, options) => String(await defaultChildRun(command, args, options)).replace(/^cores \d+$/m, 'cores 8').replace(/^load \S+$/m, 'load 0.00').replace(/^temp.*$/gm, '');
let hosts: ShardHostsFixture, hostsFile: string, worktree: string, cli: string;

before(async () => {
  hosts = await shardHosts('every-runtime', ['buildhost'], { [image]: `sha256:${'e7e7'.repeat(16)}` });
  await mkdir(hosts.state('buildhost'), { recursive: true });
  await writeFile(join(hosts.state('buildhost'), 'read-only-root'), '');
  hostsFile = join(hosts.root, 'hosts.json');
  await writeFile(hostsFile, JSON.stringify([{ target, addedAt: new Date().toISOString() }]));
  const files = Object.fromEntries(runtimes.map(runtime => [`bin/${runtime.program}`, standIn(runtime.kind, runtime.variables[0]!, runtime.login)]));
  const repository = await shardRepository('every-runtime-repo', [], files);
  for (const runtime of runtimes) git(repository.root, 'update-index', '--chmod=+x', `bin/${runtime.program}`);
  git(repository.root, 'commit', '-qm', 'runtime executables');
  git(repository.root, 'config', 'user.name', 'Worker'); git(repository.root, 'config', 'user.email', 'worker@example.com');
  worktree = join(await temporaryDirectory('every-runtime-worktrees'), 'GY-9-1');
  git(repository.root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-9-1', worktree);
  const tools = await temporaryDirectory('every-runtime-cli');
  cli = join(tools, 'bin', 'graphyard.mjs');
  await mkdir(join(tools, 'bin'));
  await writeFile(cli, 'console.log("relayed");\n');
  process.env.PATH = `${hosts.bin}:${worktree}/bin:${join(process.execPath, '..')}:${process.env.PATH}`;
});

/** Every file on the host's disk — its home (mirrors, run directories) and its Docker's state — that holds `text`. */
function filesHolding(text: string, directory = join(hosts.root, 'hosts')): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return [];
    if (stat.isDirectory()) return filesHolding(text, path);
    return stat.isFile() && readFileSync(path).includes(text) ? [path] : [];
  });
}

test(`${proof} — the worker image holds every runtime remoteRuntimes lists`, async () => {
  const trial = (await readFile(join(repo, 'Dockerfile'), 'utf8')).split(/^FROM /m).find(stage => / AS trial\n/.test(stage))!;
  assert.deepEqual([...remoteRuntimes].sort(), runtimes.map(runtime => runtime.kind).sort());
  for (const runtime of runtimes) assert.ok(trial.includes(runtime.installs), `the trial stage installs ${runtime.kind}`);
});

for (const runtime of runtimes) {
  test(`${proof} — a ${runtime.kind} builder is placed on the host, runs there, and its login never reaches the host's disk`, { timeout: 300_000 }, async () => {
    await setHostSessions(target, 1, { file: hostsFile });
    assert.equal(await remoteSessionHost(runtime.kind, () => [], idle, hostsFile), target, `a ${runtime.kind} builder goes to the host before the coordinator`);
    assert.equal(await remoteSessionHost(runtime.kind, () => [target], idle, hostsFile), null, 'with the host full it runs on the coordinator');
    const account = await temporaryDirectory(`every-runtime-${runtime.kind}`), token = `secret-${runtime.kind}-${randomUUID()}`;
    await mkdir(dirname(join(account, runtime.login)), { recursive: true });
    await writeFile(join(account, runtime.login), token, { mode: 0o600 });
    const created = (await dockerCreates(hosts.state('buildhost'))).length;
    const output: string[] = [];
    const sink = { write: (text: string) => { output.push(String(text)); return true; } } as unknown as NodeJS.WritableStream;
    const env = { PATH: process.env.PATH!, ...Object.fromEntries(runtime.variables.map(variable => [variable, account])) };
    const code = await runRemoteSession({ target, worktree, homes: [account], cli, argv: [join(worktree, 'bin', runtime.program)], env, image, output: sink, errors: sink });
    assert.equal(code, 0, output.join(''));
    const session = (await dockerCreates(hosts.state('buildhost'))).slice(created).find(words => words.some(word => word.startsWith('mainworks-session-')));
    assert.ok(session, `the ${runtime.kind} session ran in a container on the host`);
    assert.equal(git(worktree, 'log', '-1', '--format=%s'), `${runtime.kind} work on the host`, 'its commit came back here');
    assert.equal(readFileSync(join(worktree, `${runtime.kind}.txt`), 'utf8').trim().length, 64, 'it read its account\'s login');
    assert.deepEqual(filesHolding(token), [], 'no file on the host holds the login');
    assert.deepEqual(filesHolding(`refreshed-${runtime.kind}`), [], 'nor the login the provider refreshed there');
    assert.equal(await readFile(join(account, runtime.login), 'utf8'), `refreshed-${runtime.kind}`, 'the refreshed login came back here');
  });
}
