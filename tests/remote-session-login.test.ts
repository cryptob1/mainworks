import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runRemoteSession } from '../src/remote-session.js';
import { supervise } from '../src/session-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { dockerCreates, git, killTrees, shardHosts, shardRepository, type ShardHostsFixture } from './helpers/shard-hosts.js';

// GY-3405 AC-1: an agent session on an added host. The host runs the real graphyard-host-shim in its
// own home; only Docker is the fixture's stand-in, here in its read-only-root form, where a
// container's --tmpfs is a real in-memory mount (bubblewrap) and nothing else it writes outside the
// mounted checkout reaches a disk. The runtime is a stand-in `codex` committed in the repository: it
// reads its account's login at the login home's own path, commits work derived from it, refreshes
// the login, and calls `mainworks complete` with a line of its own stderr left unfinished, which the
// relay still runs here.

const proof = 'integration:remote-session-login';
const image = 'graphyard-trial:remote-session';
const target = 'gy-compute@sessionhost';
const runtime = `#!/bin/sh
set -e
token=$(python3 -c 'import json, os; print(json.load(open(os.environ["CODEX_HOME"] + "/auth.json"))["token"])')
printf '%s' "$token" | sha256sum | cut -d' ' -f1 > work.txt
date +%s%N > progress.txt
: > .waiting
while [ ! -e .go ]; do sleep 0.1; done
git add work.txt && git commit -qm "work done on the host"
printf '{"token":"refreshed-by-the-provider"}' > "$CODEX_HOME/auth.json"
printf 'half a line, no newline yet' >&2
node "$GRAPHYARD_CLI" complete GY-1 1 --head
echo "the runtime finished"
`;
let hosts: ShardHostsFixture, worktree: string, account: string, cli: string, calls: string, token: string;
const previousPath = process.env.PATH;

before(async () => {
  hosts = await shardHosts('remote-session', ['sessionhost'], { [image]: `sha256:${'5e55'.repeat(16)}` });
  await mkdir(hosts.state('sessionhost'), { recursive: true });
  await writeFile(join(hosts.state('sessionhost'), 'read-only-root'), '');
  const repository = await shardRepository('remote-session-repo', [], { 'bin/codex': runtime, '.gitignore': '.waiting\n.go\n' });
  git(repository.root, 'update-index', '--chmod=+x', 'bin/codex'); git(repository.root, 'commit', '-qm', 'runtime executable');
  git(repository.root, 'config', 'user.name', 'Worker'); git(repository.root, 'config', 'user.email', 'worker@example.com');
  worktree = join(await temporaryDirectory('remote-session-worktrees'), 'GY-1-1');
  git(repository.root, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  account = await temporaryDirectory('remote-session-account');
  token = `secret-${randomUUID()}`;
  await writeFile(join(account, 'auth.json'), JSON.stringify({ token }), { mode: 0o600 });
  const tools = await temporaryDirectory('remote-session-cli');
  cli = join(tools, 'bin', 'graphyard.mjs'); calls = join(tools, 'calls.jsonl');
  await mkdir(join(tools, 'bin'));
  await writeFile(cli, `import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }) + '\\n');
console.log('GY-1 epoch 1 submitted');
`);
  // The fixture's ssh and Docker first; the runtime and node for the session, which is given this PATH.
  process.env.PATH = `${hosts.bin}:${worktree}/bin:${join(process.execPath, '..')}:${previousPath}`;
});
after(() => { process.env.PATH = previousPath; });

// No Git identity is forwarded by hand: the session commits under this worktree's own.
const env = () => ({ CODEX_HOME: account, PATH: process.env.PATH! });
/** Every file on the host's disk — its home (mirrors, run directories) and its Docker's state — that holds `text`. */
function filesHolding(text: string, directory = join(hosts.root, 'hosts')): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return [];
    if (stat.isDirectory()) return filesHolding(text, path);
    return stat.isFile() && readFileSync(path).includes(text) ? [path] : [];
  });
}
/** Wait until this machine's worktree holds `file` as the host's checkout has it, uncommitted: the session's state mirrored here while it runs. */
async function mirrored(checkout: string, file: string) {
  const expected = readFileSync(join(checkout, file), 'utf8');
  for (let tries = 0; tries < 300; tries++) {
    if (existsSync(join(worktree, file)) && readFileSync(join(worktree, file), 'utf8') === expected) return git(worktree, 'status', '--porcelain', '--', file);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${file} never reached this machine's worktree`);
}
/** The checkout of the session running on the host now: the one whose runtime has started. */
async function runningCheckout(said: () => string = () => '') {
  const runs = join(hosts.home('sessionhost'), '.graphyard', 'runs');
  for (let tries = 0; tries < 600; tries++) {
    const found = existsSync(runs) ? readdirSync(runs).map(name => join(runs, name, 'repo')).find(repo => existsSync(join(repo, '.waiting')) && !existsSync(join(repo, '.go'))) : undefined;
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`the session never started on the host: ${said()}`);
}

test(`${proof} — a session on an added host uses its account, no login file is on the host's disk during or after it, and its work and complete come back here`, { timeout: 300_000 }, async () => {
  const output: string[] = [];
  const sink = { write: (text: string) => { output.push(String(text)); return true; } } as unknown as NodeJS.WritableStream;
  const session = runRemoteSession({ target, worktree, homes: [account], cli, argv: [join(worktree, 'bin', 'codex')], env: env(), image, output: sink, errors: sink });
  const checkout = await runningCheckout(() => output.join(''));
  assert.deepEqual(filesHolding(token), [], 'while the session runs, no file on the host holds the login');
  assert.equal(readFileSync(join(checkout, 'work.txt'), 'utf8').trim(), createHash('sha256').update(token).digest('hex'), 'the session read its account\'s login');
  assert.equal(await mirrored(checkout, 'work.txt'), '?? work.txt', 'while it runs, its uncommitted work is here too, so the loop sees its progress');
  await writeFile(join(checkout, '.go'), '');
  const code = await session;
  assert.equal(code, 0, output.join(''));
  assert.match(output.join(''), /the runtime finished/);
  assert.match(output.join(''), /half a line, no newline yet\n/, 'what the runtime wrote before its call, unfinished line and all, is shown whole');
  assert.deepEqual(filesHolding(token), [], 'after it, no file on the host holds the login');
  assert.deepEqual(filesHolding('refreshed-by-the-provider'), [], 'nor the login the provider refreshed there');
  assert.equal(JSON.parse(await readFile(join(account, 'auth.json'), 'utf8')).token, 'refreshed-by-the-provider', 'the refreshed login came back here');
  const head = git(worktree, 'rev-parse', 'HEAD');
  assert.equal(git(worktree, 'log', '-1', '--format=%s'), 'work done on the host', 'the session\'s commit is in this worktree');
  assert.equal(git(worktree, 'log', '-1', '--format=%an <%ae>'), 'Worker <worker@example.com>', 'the session committed under this worktree\'s Git identity');
  assert.equal(git(worktree, 'status', '--porcelain'), '?? progress.txt', 'what it left uncommitted is here, uncommitted');
  const [call] = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(call.argv, ['complete', 'GY-1', '1', '--head']);
  assert.equal(call.head, head, 'complete ran here on the session\'s own head');
  const create = (await dockerCreates(hosts.state('sessionhost'))).find(words => words.some(word => word.startsWith('mainworks-session-')))!;
  assert.equal(create[create.indexOf('--log-driver') + 1], 'none', 'Docker keeps no log of what the session says, the login handed back among it');
  assert.ok(create.includes('--memory'), 'the session runs under a memory limit');
  assert.equal(create[create.indexOf('--entrypoint') + 1], '/usr/bin/timeout', 'the session stops at its deadline on its own');
  for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges']) assert.ok(create.includes(flag), `the session container is created ${flag}, as a trial's is, so its root is no disk it writes to`);
});

test(`${proof} — a host that drops ends the session, and its supervisor releases the lease so the item returns to the queue`, { timeout: 300_000 }, async () => {
  const released: string[] = [];
  const renew = async () => ({ lease: { epoch: 1, expiresAt: new Date(Date.now() + 120_000).toISOString() }, updatedAt: new Date().toISOString() });
  const forwarded = env();
  const words = [...Object.keys(forwarded).flatMap(name => ['--env', name]), '--home', account, '--cli', cli, '--', join(worktree, 'bin', 'codex')];
  Object.assign(process.env, forwarded, { GRAPHYARD_TRIAL_IMAGE: image });
  const cwd = process.cwd();
  process.chdir(worktree);
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const supervised = supervise(process.execPath, ['--import', createRequire(join(root, 'package.json')).resolve('tsx'), join(root, 'src', 'cli.ts'), 'host', 'session', target, ...words], 1, renew as any,
      { session: { surrender: async cause => { released.push(cause); } } });
    const checkout = await runningCheckout();
    assert.deepEqual(filesHolding(token), [], 'no file on the host holds the login');
    await mirrored(checkout, 'progress.txt');
    killTrees((_, directory) => directory.startsWith(hosts.home('sessionhost')));
    const code = await supervised;
    assert.notEqual(code, 0);
    assert.equal(released.length, 1, 'the supervisor released the lease once');
    assert.deepEqual(filesHolding(token), [], 'the dropped host holds no login');
    assert.match(git(worktree, 'status', '--porcelain'), /progress\.txt/, 'the session\'s uncommitted work is in this worktree, kept for the successor');
    const containers = () => Object.keys(JSON.parse(readFileSync(join(hosts.state('sessionhost'), 'state.json'), 'utf8')).containers).filter(name => name.startsWith('mainworks-session-'));
    for (let tries = 0; tries < 100 && containers().length; tries++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(containers(), [], 'the session container is removed though its launch was killed');
  } finally { process.chdir(cwd); }
});
