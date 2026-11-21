import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteWorkerRuns, startHeadlessWorker } from '../src/headless-session.js';
import { setHostSessions } from '../src/hosts.js';
import { remoteSessionHost } from '../src/remote-session.js';
import { clearRuns } from '../src/runner/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3405 AC-2: a worker session on an added host, end to end. The host (the fixture's, with the real
// graphyard-host-shim and Docker's read-only-root stand-in, where --tmpfs is memory) is opened to one
// session with `host sessions`; the dispatch's placement picks it for a runtime its image holds. The
// worker run starts as the loop starts it — startHeadlessWorker with the `graphyard host session`
// words in place of this machine's confinement — runs on the host, commits, and calls `complete`,
// which runs here on the commit it made. Its run record names the host: what master status serves
// as remoteSessions.

const proof = 'e2e:remote-agent-session';
const image = 'graphyard-trial:remote-agent';
const target = 'gy-compute@agenthost';
const repo = fileURLToPath(new URL('..', import.meta.url));
const runtime = `#!/bin/sh
set -e
case "$*" in *--help*) exit 0 ;; esac
test -s "$PI_CODING_AGENT_DIR/auth.json"
echo "done on the host" > work.txt
git add work.txt && git commit -qm "the item's work"
node "$GRAPHYARD_CLI" complete GY-7 1 --head
`;
let hosts: ShardHostsFixture, hostsFile: string, worktree: string, root: string, account: string, cli: string, calls: string;
const previous = { PATH: process.env.PATH, GRAPHYARD_TRIAL_IMAGE: process.env.GRAPHYARD_TRIAL_IMAGE };

before(async () => {
  hosts = await shardHosts('remote-agent', ['agenthost'], { [image]: `sha256:${'a9e7'.repeat(16)}` });
  await mkdir(hosts.state('agenthost'), { recursive: true });
  await writeFile(join(hosts.state('agenthost'), 'read-only-root'), '');
  hostsFile = join(hosts.root, 'hosts.json');
  await writeFile(hostsFile, JSON.stringify([{ target, addedAt: new Date().toISOString() }]));
  const repository = await shardRepository('remote-agent-repo', [], { 'bin/pi': runtime });
  git(repository.root, 'update-index', '--chmod=+x', 'bin/pi'); git(repository.root, 'commit', '-qm', 'runtime executable');
  worktree = join(await temporaryDirectory('remote-agent-worktrees'), 'GY-7-1');
  git(repository.root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-7-1', worktree);
  root = await temporaryDirectory('remote-agent-loop');
  account = await temporaryDirectory('remote-agent-account');
  await writeFile(join(account, 'auth.json'), JSON.stringify({ zai: { type: 'api_key', key: 'secret-remote-agent' } }), { mode: 0o600 });
  const tools = await temporaryDirectory('remote-agent-cli');
  cli = join(tools, 'bin', 'graphyard.mjs'); calls = join(tools, 'calls.jsonl');
  await mkdir(join(tools, 'bin'));
  await writeFile(cli, `import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }) + '\\n');
console.log('GY-7 epoch 1 submitted');
`);
  process.env.PATH = `${hosts.bin}:${worktree}/bin:${join(process.execPath, '..')}:${previous.PATH}`;
  process.env.GRAPHYARD_TRIAL_IMAGE = image;
});
after(() => { clearRuns(); Object.assign(process.env, previous); });

/** The worker run's command, as the headless exec runs it: its output once it exits 0, else a throw. */
const exec = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => new Promise<string>((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('close', code => code === 0 ? resolve(output) : reject(Object.assign(new Error(`exit ${code}: ${output}`), { output })));
});

test(`${proof} — a host opened to sessions takes a worker of a runtime its image holds, and only up to its count`, async () => {
  assert.equal(await remoteSessionHost('codex', [], undefined, hostsFile), null, 'a host added for shards takes no session');
  await setHostSessions(target, 1, { file: hostsFile });
  assert.equal(await remoteSessionHost('codex', [], undefined, hostsFile), target);
  assert.equal(await remoteSessionHost('codex', [target], undefined, hostsFile), null, 'a host with its one session running takes no second');
  assert.equal(await remoteSessionHost('claude', [], undefined, hostsFile), null, 'a runtime the image lacks stays on this machine');
});

test(`${proof} — the worker session runs on the added host and completes its item; its run names where it ran`, { timeout: 300_000 }, async () => {
  const words = [process.execPath, '--import', createRequire(join(repo, 'package.json')).resolve('tsx'), join(repo, 'src', 'cli.ts'), 'host', 'session', target,
    '--home', account, '--env', 'PI_CODING_AGENT_DIR', '--env', 'PATH', ...['NAME', 'EMAIL'].flatMap(part => ['--env', `GIT_AUTHOR_${part}`, '--env', `GIT_COMMITTER_${part}`]), '--cli', cli, '--'];
  let printed = '';
  const started = await startHeadlessWorker({ name: 'eng-pi', work: 'GY-7', subject: 'GY-7: remote work', epoch: 1, principal: 'worker-a', account: null, kind: 'pi', args: [],
    environment: { PATH: process.env.PATH!, GRAPHYARD_TRIAL_IMAGE: image, PI_CODING_AGENT_DIR: account, GIT_AUTHOR_NAME: 'Worker', GIT_AUTHOR_EMAIL: 'worker@example.com', GIT_COMMITTER_NAME: 'Worker', GIT_COMMITTER_EMAIL: 'worker@example.com' },
    directory: worktree, supervisor: [], prompt: 'Implement GY-7.', root, timeoutMs: 240_000, startupMs: 240_000, remote: { host: target, words },
    exec: async (command, args, options) => { try { return printed = await exec(command, args, options); } catch (error) { printed = String((error as { output?: string }).output); throw error; } } });
  assert.deepEqual(started.ended && { ok: started.ended.ok }, { ok: true }, printed);
  const head = git(worktree, 'rev-parse', 'HEAD');
  assert.equal(git(worktree, 'log', '-1', '--format=%s'), 'the item\'s work', 'the commit made on the host is in the worktree');
  const [call] = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(call, { argv: ['complete', 'GY-7', '1', '--head'], head }, 'complete ran here on that commit');
  assert.deepEqual(remoteWorkerRuns(root).map(run => ({ work: run.work, host: run.host, running: run.running })), [{ work: 'GY-7', host: target, running: false }], 'master status reads where it ran');
});
