// Concern: GY-3405 — an agent session on an added host. A host that `mainworks host sessions` opened to
// sessions takes worker sessions of the runtimes its image holds; GY-4004: that is every runtime the
// builders use, so a builder runs on a host with room before this machine. The session's commit goes to the host
// as a merge trial's does (its mirror, the warm image), and the shim's `run-session` runs the runtime there
// in a container with the checkout mounted at the worktree's own path. The account login is handed over
// for that one session: it travels on the SSH channel's stdin into the container, which writes it into an
// in-memory tmpfs at the login home's own path, so no file of it is ever written to the host's disk; the
// tmpfs goes with the container. A login the provider refreshed during the session comes back the same
// way and is written here. The session's `mainworks` calls are relayed to this machine over the same
// channel and run here in the worktree. The worktree here mirrors the host's checkout while the session
// runs (its commits and, uncommitted, its changed files), so the loop's attempt bound sees its progress,
// a stop keeps its uncommitted work as a local session's, and `complete` submits a head held here. A host that drops ends the SSH channel, so the
// runtime exits and its `watch` supervisor releases the lease: the item returns to the queue. A session that fails before the agent wrote anything
// (GY-4057's failed preparation, GY-4062's host that cannot run it) never spends the attempt: the same supervisor starts it here instead.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { coolSessionHost, sessionCooldown, probeHost, readHosts, type HostRecord, type SessionCooldown } from './hosts.js';
import { remoteShardSession, shardSshSession } from './merge-writer/remote-shards.js';
import { trialImage } from './merge-writer/trial-container.js';
import { trialHotCelsius } from './merge-writer/trial-load.js';

/** Runtimes the worker image holds (the Dockerfile's trial stage): only their sessions run on a host. */
export const remoteRuntimes: readonly string[] = ['claude', 'codex', 'opencode', 'cursor'];
/** The files of a login home that hold its sign-in and settings: what is handed over, and handed back when changed. */
const loginFiles = ['.credentials.json', '.claude.json', 'settings.json', 'auth.json', 'config.toml', 'opencode/auth.json', 'cursor/auth.json', 'cli-config.json'];
const sessionDirectory = '/tmp/mainworks-session';
const marker = '\u001emainworks-';
/** How often the session's checkout state is sent here while it runs. */
const syncSeconds = 5;

/**
 * Runs inside the container as its first process: writes the handed-over files (the login, the
 * relay) into their tmpfs homes and runs the runtime with its stderr passed through here, so each
 * frame is a line of its own. Every few seconds, before each relayed `mainworks` call and when the
 * runtime ends, it sends the checkout's state as a `work` frame: its HEAD and, when files changed,
 * a snapshot commit of them, bundled since the session's start. This machine's worktree mirrors
 * it, so the loop sees the session's progress and keeps its uncommitted work as it would a local
 * session's. Last it sends back any login file the provider changed. Nothing it writes outlives the container.
 */
export const sessionBoot = String.raw`import base64, json, os, shutil, subprocess, sys, threading, time
session = '${sessionDirectory}'
def line():
    data = b''
    while True:
        byte = os.read(0, 1)
        if not byte:
            return data or None
        if byte == b'\n':
            return data
        data += byte
handover = json.loads(line())
files = {path: base64.b64decode(text) for path, text in handover['files'].items()}
for path, data in files.items():
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, data)
    os.close(fd)
os.makedirs(os.environ['HOME'], mode=0o700, exist_ok=True)
os.makedirs(session, mode=0o700, exist_ok=True)
def git(*words, env=None):
    return subprocess.run(['git'] + list(words), capture_output=True, env=env)
out = lambda *words, env=None: git(*words, env=env).stdout.decode().strip()
start = out('rev-parse', 'HEAD')
if os.path.exists(os.path.join(session, 'calls')):
    os.remove(os.path.join(session, 'calls'))
os.mkfifo(os.path.join(session, 'calls'), 0o600)
lock, state, pending, sent = threading.Lock(), threading.Lock(), set(), {}
unfinished = False
def write(data):
    while data:
        data = data[os.write(2, data):]
# The runtime's stderr comes through here, never straight to fd 2, so a frame always starts its own line.
def say(kind, text):
    global unfinished
    with lock:
        write((b'\n' if unfinished else b'') + ('\x1emainworks-' + kind + ' ' + text + '\n').encode())
        unfinished = False
def sync():
    # A state that cannot be read now is sent at the next tick; the relayed call it precedes still goes.
    try:
        send()
    except Exception:
        pass
def send():
    # The checkout as it stands: HEAD, and a snapshot commit of its changed files when there are any.
    with state:
        head = out('rev-parse', 'HEAD')
        if not head:
            return
        index = os.path.join(session, 'index')
        shutil.copyfile(out('rev-parse', '--path-format=absolute', '--git-path', 'index'), index)
        env = dict(os.environ, GIT_INDEX_FILE=index, GIT_AUTHOR_NAME='Mainworks', GIT_AUTHOR_EMAIL='mainworks@localhost', GIT_COMMITTER_NAME='Mainworks', GIT_COMMITTER_EMAIL='mainworks@localhost')
        # The helper links the warm image's node_modules into the checkout: a symlink no node_modules/ rule ignores, never the session's work.
        git('add', '-A', '--', '.', ':(exclude)node_modules', env=env)
        tree = out('write-tree', env=env)
        if sent.get('state') == (head, tree):
            return
        work = head if tree == out('rev-parse', 'HEAD^{tree}') else out('commit-tree', tree, '-p', head, '-m', 'uncommitted work', env=env)
        if not work:
            return
        bundle = None
        if work != start:
            git('update-ref', 'refs/graphyard/work', work)
            path = os.path.join(session, 'work.bundle')
            if git('bundle', 'create', path, 'refs/graphyard/work', '^' + start, *(['^' + sent['head']] if sent.get('head') else [])).returncode == 0:
                bundle = base64.b64encode(open(path, 'rb').read()).decode()
        say('work', json.dumps({'head': head, 'work': work, 'bundle': bundle}))
        sent.update(head=head, state=(head, tree))
def said():
    global unfinished
    while True:
        data = os.read(runtime.stderr.fileno(), 65536)
        if not data:
            return
        with lock:
            # A runtime line that looks like a frame is shown, never obeyed.
            write(data.replace(b'\x1e', b'^'))
            unfinished = not data.endswith(b'\n')
def calls():
    while True:
        with open(os.path.join(session, 'calls')) as fifo:
            for request in fifo:
                pending.add(json.loads(request)['id'])
                sync()
                say('call', request.strip())
def answers():
    while True:
        text = line()
        if text is None:
            # The channel closed: this machine is gone, so no relayed call can be answered. End the runtime.
            runtime.terminate()
            return
        reply = json.loads(text)
        if reply.get('commits'):
            with state:
                path = os.path.join(session, 'answer.bundle')
                open(path, 'wb').write(base64.b64decode(reply['commits']))
                tips = out('bundle', 'unbundle', path).split()
                if tips:
                    git('merge', '-q', '--ff-only', tips[0])
        target = os.path.join(session, 'answer-' + reply['id'] + '.json')
        open(target + '.part', 'wb').write(text)
        os.rename(target + '.part', target)
        pending.discard(reply['id'])
def watch():
    while True:
        time.sleep(${syncSeconds})
        if not pending:
            sync()
runtime = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stderr=subprocess.PIPE)
say('started', '{}')
errors = threading.Thread(target=said, daemon=True)
errors.start()
for task in (calls, answers, watch):
    threading.Thread(target=task, daemon=True).start()
code = runtime.wait()
errors.join(5)
sync()
back = {}
for path in handover['back']:
    try:
        now = open(path, 'rb').read()
    except OSError:
        continue
    if now != files.get(path):
        back[path] = base64.b64encode(now).decode()
say('login', json.dumps(back))
sys.exit(code)
`;

/** The `mainworks` the session calls, at the CLI's own path: each call goes to this machine, after the checkout's state, and its answer comes back. */
const sessionRelay = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const session = ${JSON.stringify(sessionDirectory)}, id = randomUUID();
writeFileSync(session + '/calls', JSON.stringify({ id, argv: process.argv.slice(2) }) + '\\n', { flag: 'a' });
const answer = session + '/answer-' + id + '.json';
while (!existsSync(answer)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
const reply = JSON.parse(readFileSync(answer, 'utf8'));
process.stdout.write(reply.stdout); process.stderr.write(reply.stderr); process.exitCode = reply.status;
`;

export interface RemoteSession {
  target: string; worktree: string;
  hostsFile?: string;
  /** The launcher's local command, including confinement and local runtime flags. */
  localArgv?: string[];
  onLocal?: () => void;
  /** Login homes whose sign-in files are handed over: each becomes an in-memory home at the same path there. */
  homes: string[];
  /** This machine's CLI, which the relayed calls run; the session's `mainworks` at the same path is the relay. */
  cli: string;
  argv: string[]; env: Record<string, string>;
  /** This machine's confinement words for the session, which every relayed call runs under, as a local worker's calls do. */
  confine?: string[];
  run?: ChildRun; image?: string; output?: NodeJS.WritableStream; errors?: NodeJS.WritableStream;
}

/** The exit code a dropped host gives: SSH's own. */
const droppedExit = 255;

/** Host-side `--settings` harness files outside the worktree: handed into the container's tmpfs, never written back. */
function remoteSettingsFiles(argv: readonly string[], worktree: string): string[] {
  const root = resolve(worktree);
  const paths: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index]!;
    const value = word === '--settings' ? argv[++index] : word.startsWith('--settings=') ? word.slice('--settings='.length) : undefined;
    if (!value || !isAbsolute(value)) continue;
    const target = resolve(value);
    if (target === root || target.startsWith(`${root}/`)) continue;
    try { if (statSync(target).isFile()) paths.push(value); } catch {}
  }
  return [...new Set(paths)];
}

class SessionPreparationError extends Error {}

/** Preparation never ends the attempt: the same supervisor starts its local command instead. */
export async function runRemoteSession(input: RemoteSession): Promise<number> {
  const paused = await sessionCooldown(input.target, input.hostsFile);
  try {
    if (paused) throw new SessionPreparationError(paused.reason);
    return await runOnHost(input);
  } catch (error) {
    if (!(error instanceof SessionPreparationError)) throw error;
    if (!paused) await coolSessionHost(input.target, error.message, input.hostsFile);
    (input.errors ?? process.stderr).write(`Sessions paused on ${input.target}: ${error.message}. Starting this attempt on this machine.\n`);
    input.onLocal?.();
    const [command, ...args] = input.localArgv ?? [...input.confine ?? [], ...input.argv];
    return new Promise<number>((resolve, reject) => {
      const child = spawn(command!, args, { cwd: input.worktree, env: { ...process.env, ...input.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => (input.output ?? process.stdout).write(chunk));
      child.stderr.on('data', chunk => (input.errors ?? process.stderr).write(chunk));
      child.on('error', reject);
      child.on('close', code => resolve(code ?? droppedExit));
    });
  }
}

/** Run one agent session on `target` and return its exit code; the commits it made are in the worktree after. */
async function runOnHost(input: RemoteSession): Promise<number> {
  const run = input.run ?? defaultChildRun, output = input.output ?? process.stdout, errors = input.errors ?? process.stderr;
  const git = async (...args: string[]) => String(await run('git', ['-C', input.worktree, ...args])).trim();
  const sha = await git('rev-parse', 'HEAD');
  const root = dirname(await git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  const transport = shardSshSession(run);
  const shards = remoteShardSession({ root, sha, image: input.image ?? trialImage(), run, deadline: Date.now() + 24 * 3600_000, transport });
  const scratch = await mkdtemp(join(tmpdir(), 'mainworks-session-'));
  try {
    let runName: string;
    try { runName = await shards.ready(input.target); }
    catch (error) { throw new SessionPreparationError(error instanceof Error ? error.message : String(error)); }
    const login = input.homes.flatMap(home => loginFiles.map(name => join(home, name)).filter(path => existsSync(path)));
    const harness = remoteSettingsFiles(input.argv, input.worktree);
    const files = Object.fromEntries([
      ...login.map(path => [path, readFileSync(path).toString('base64')]),
      ...harness.map(path => [path, readFileSync(path).toString('base64')]),
      [input.cli, Buffer.from(sessionRelay).toString('base64')],
    ]);
    // The session commits under this machine's Git identity: its home there is empty.
    const setting = (key: string) => git('config', key).catch(() => '');
    const [name, email] = [await setting('user.name'), await setting('user.email')];
    const identity = { ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}), ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}) };
    const request = {
      argv: ['python3', '-I', '-c', sessionBoot, basename(input.argv[0]!), ...input.argv.slice(1)],
      env: { ...identity, ...input.env, HOME: '/tmp/mainworks-home', GRAPHYARD_CLI: input.cli, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' },
      cwd: input.worktree, homes: [...new Set([...input.homes, ...harness.map(path => dirname(path)), dirname(input.cli)])],
    };
    /** Make the worktree what the session's checkout is: its HEAD, with the snapshot's changes uncommitted on top, as a local session's would be. */
    const mirror = async (body: string) => {
      const { head, work, bundle } = JSON.parse(body) as { head: string; work: string; bundle: string | null };
      if (bundle) {
        const path = join(scratch, `${randomUUID()}.bundle`);
        await writeFile(path, Buffer.from(bundle, 'base64'));
        await git('bundle', 'unbundle', path);
        await rm(path, { force: true });
      }
      await git('reset', '-q', '--hard', head);
      await git('clean', '-fdq', '-e', 'node_modules');
      if (work !== head) {
        // Apply the snapshot through a scratch index so the real index stays at `head` and mirrored
        // uncommitted files never briefly appear staged (`A `) between read-tree and reset.
        const index = join(scratch, `${randomUUID()}.index`);
        try {
          const current = await git('rev-parse', '--path-format=absolute', '--git-path', 'index');
          if (existsSync(current)) await copyFile(current, index);
          await run('git', ['-C', input.worktree, 'read-tree', '-u', '--reset', work], { env: { ...process.env, GIT_INDEX_FILE: index } });
        } finally {
          await rm(index, { force: true });
        }
      }
    };
    let agentStarted = false, preparationError = '', printed = false;
    const code = await transport.session(input.target, words => new Promise<number>(resolve => {
      const child = spawn('ssh', [...words, `run-session ${runName}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.write(`${JSON.stringify(request)}\n${JSON.stringify({ files, back: login })}\n`);
      child.stdout.on('data', chunk => { printed = true; output.write(chunk); });
      let queue = Promise.resolve();
      const call = async (text: string) => {
        const { id, argv } = JSON.parse(text) as { id: string; argv: string[] };
        let reply: { status: number; stdout: string; stderr: string; commits: string | null } = { status: 1, stdout: '', stderr: '', commits: null };
        try {
          const before = await git('rev-parse', 'HEAD');
          const [program, ...words] = [...input.confine ?? [], process.execPath, input.cli, ...argv];
          const ran = await new Promise<{ status: number; stdout: string; stderr: string }>(done => execFile(program!, words, { cwd: input.worktree, maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) => done({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
          const after = await git('rev-parse', 'HEAD');
          let back: string | null = null;
          if (after !== before) {
            const bundle = join(scratch, `${id}.bundle`);
            await git('bundle', 'create', bundle, 'HEAD', `^${before}`);
            back = readFileSync(bundle).toString('base64');
            rmSync(bundle, { force: true });
          }
          reply = { ...ran, commits: back };
        } catch (error) { reply.stderr = `mainworks relay: ${error instanceof Error ? error.message : String(error)}\n`; }
        child.stdin.write(`${JSON.stringify({ id, ...reply })}\n`);
      };
      createInterface({ input: child.stderr }).on('line', line => {
        if (!line.startsWith(marker)) { printed = true; preparationError = (preparationError + line + '\n').slice(-500); errors.write(`${line}\n`); return; }
        const space = line.indexOf(' '), kind = line.slice(marker.length, space), body = line.slice(space + 1);
        queue = queue.then(async () => {
          if (kind === 'started') agentStarted = true;
          else if (kind === 'call') await call(body);
          else if (kind === 'work') await mirror(body);
          else if (kind === 'login') for (const [path, text] of Object.entries(JSON.parse(body) as Record<string, string>)) if (login.includes(path)) writeFileSync(path, Buffer.from(text, 'base64'), { mode: 0o600 });
        }).catch(error => { errors.write(`mainworks relay: ${error instanceof Error ? error.message : String(error)}\n`); });
      });
      child.on('error', error => { preparationError = error.message; resolve(droppedExit); });
      child.on('close', status => { void queue.then(() => resolve(status ?? droppedExit)); });
    }));
    // GY-4057: the helper's own failure before the agent started. GY-4062: a failed session that ended before the agent wrote a line — a host
    // that cannot run it starts the agent, which exits at once with nothing said — is the same setup failure, so the attempt goes on elsewhere
    // and is not spent. A session that exits 0 finished, whatever it printed.
    if (code !== 0 && (!agentStarted || !printed)) throw new SessionPreparationError(preparationError.trim() || (agentStarted ? `the agent exited ${code} before writing any output` : `helper exited ${code} before the agent started`));
    if (code === droppedExit) errors.write(`The session on ${input.target} ended: the host dropped, so the attempt ends and the item returns to the queue\n`);
    return code;
  } finally {
    await shards.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A ready, cool added host open to sessions with room for one more of `kind` and shard room left; null keeps the session on this machine. */
export async function remoteSessionHost(kind: string, live: () => readonly string[], run: ChildRun = defaultChildRun, file?: string): Promise<string | null> {
  if (!remoteRuntimes.includes(kind)) return null;
  for (const host of await readHosts(file).catch(() => [])) {
    if (await sessionCooldown(host.target, file)) continue;
    if (!host.sessions || live().filter(target => target === host.target).length >= host.sessions) continue;
    // A helper older than sessions takes shards only, until `host add` updates it; `host list` names why.
    const probe = await probeHost(host.target, run);
    // GY-4004: a host whose load leaves its trials no shard room (cores less two, as shards are placed) takes no builder.
    const shardRoom = probe.ok && probe.cores ? probe.cores - 2 - (probe.load ?? 0) : 0;
    if (probe.ok && probe.verbs?.includes('run-session:1') && (probe.celsius === null || probe.celsius < trialHotCelsius) && shardRoom > 0) return host.target;
  }
  return null;
}

/** GY-4004: the builder sessions running now on this machine (null) and on each host open to sessions, beside its room; GY-4062: `takesNone` is why one takes none. */
export function builderSessionCounts(running: readonly (string | null)[], hosts: readonly (Pick<HostRecord, 'target' | 'sessions'> & { sessionCooldown?: SessionCooldown | null; takesNone?: string })[]) {
  return {
    coordinator: running.filter(host => !host).length,
    hosts: hosts.filter(host => host.sessions).map(host => ({ host: host.target, running: running.filter(entry => entry === host.target).length, room: host.sessions!, ...(host.takesNone ? { takesNone: host.takesNone } : {}), ...(host.sessionCooldown ? { sessionCooldown: host.sessionCooldown } : {}) })),
  };
}
