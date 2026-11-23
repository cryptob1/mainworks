// Concern: GY-3405 — an agent session on an added host. A host that `mainworks host sessions` opened to
// sessions takes worker sessions of the runtimes its image holds. The session's commit goes to the host
// as a merge trial's does (its mirror, the warm image), and the shim's `run-session` runs the runtime there
// in a container with the checkout mounted at the worktree's own path. The account login is handed over
// for that one session: it travels on the SSH channel's stdin into the container, which writes it into an
// in-memory tmpfs at the login home's own path, so no file of it is ever written to the host's disk; the
// tmpfs goes with the container. A login the provider refreshed during the session comes back the same
// way and is written here. The session's `mainworks` calls are relayed to this machine over the same
// channel and run here in the worktree. The worktree here mirrors the host's checkout while the session
// runs (its commits and, uncommitted, its changed files), so the loop's attempt bound sees its progress,
// a stop keeps its uncommitted work as a local session's, and `complete` submits a head held here. A host that drops ends the SSH channel, so the
// runtime exits and its `watch` supervisor releases the lease: the item returns to the queue.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { probeHost, readHosts } from './hosts.js';
import { remoteShardSession, shardSshSession } from './merge-writer/remote-shards.js';
import { trialImage } from './merge-writer/trial-container.js';

/** Runtimes the worker image holds (the Dockerfile's trial stage): only their sessions run on a host. */
export const remoteRuntimes = ['codex'];
/** The files of a login home that hold its sign-in and settings: what is handed over, and handed back when changed. */
export const loginFiles = ['.credentials.json', '.claude.json', 'settings.json', 'auth.json', 'config.toml', 'opencode/auth.json', 'cursor/auth.json', 'cli-config.json'];
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
                git('fetch', '-q', path, 'HEAD')
                git('merge', '-q', '--ff-only', 'FETCH_HEAD')
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
export const sessionRelay = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
export const droppedExit = 255;

/** Run one agent session on `target` and return its exit code; the commits it made are in the worktree after. */
export async function runRemoteSession(input: RemoteSession): Promise<number> {
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
    catch (error) { errors.write(`The session could not start on ${input.target}: ${error instanceof Error ? error.message : String(error)}\n`); return droppedExit; }
    const login = input.homes.flatMap(home => loginFiles.map(name => join(home, name)).filter(path => existsSync(path)));
    const files = Object.fromEntries([...login.map(path => [path, readFileSync(path).toString('base64')]), [input.cli, Buffer.from(sessionRelay).toString('base64')]]);
    // The session commits under this machine's Git identity: its home there is empty.
    const setting = (key: string) => git('config', key).catch(() => '');
    const [name, email] = [await setting('user.name'), await setting('user.email')];
    const identity = { ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}), ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}) };
    const request = {
      argv: ['python3', '-I', '-c', sessionBoot, basename(input.argv[0]!), ...input.argv.slice(1)],
      env: { ...identity, ...input.env, HOME: '/tmp/mainworks-home', GRAPHYARD_CLI: input.cli, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' },
      cwd: input.worktree, homes: [...new Set([...input.homes, dirname(input.cli)])],
    };
    /** Make the worktree what the session's checkout is: its HEAD, with the snapshot's changes uncommitted on top, as a local session's would be. */
    const mirror = async (body: string) => {
      const { head, work, bundle } = JSON.parse(body) as { head: string; work: string; bundle: string | null };
      if (bundle) {
        const path = join(scratch, `${randomUUID()}.bundle`);
        await writeFile(path, Buffer.from(bundle, 'base64'));
        await git('fetch', '-q', path, 'refs/graphyard/work');
        await rm(path, { force: true });
      }
      await git('reset', '-q', '--hard', head);
      await git('clean', '-fdq', '-e', 'node_modules');
      if (work !== head) { await git('read-tree', '-u', '--reset', work); await git('reset', '-q'); }
    };
    const code = await transport.session(input.target, words => new Promise<number>(resolve => {
      const child = spawn('ssh', [...words, `run-session ${runName}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.write(`${JSON.stringify(request)}\n${JSON.stringify({ files, back: login })}\n`);
      child.stdout.on('data', chunk => output.write(chunk));
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
        if (!line.startsWith(marker)) { errors.write(`${line}\n`); return; }
        const space = line.indexOf(' '), kind = line.slice(marker.length, space), body = line.slice(space + 1);
        queue = queue.then(async () => {
          if (kind === 'call') await call(body);
          else if (kind === 'work') await mirror(body);
          else if (kind === 'login') for (const [path, text] of Object.entries(JSON.parse(body) as Record<string, string>)) if (login.includes(path)) writeFileSync(path, Buffer.from(text, 'base64'), { mode: 0o600 });
        }).catch(error => { errors.write(`mainworks relay: ${error instanceof Error ? error.message : String(error)}\n`); });
      });
      child.on('close', status => { void queue.then(() => resolve(status ?? droppedExit)); });
    }));
    if (code === droppedExit) errors.write(`The session on ${input.target} ended: the host dropped, so the attempt ends and the item returns to the queue\n`);
    return code;
  } finally {
    await shards.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

/** An added host open to sessions with room for one more of `kind`, answering its probe now; null keeps the session on this machine. */
export async function remoteSessionHost(kind: string, live: () => readonly string[], run: ChildRun = defaultChildRun, file?: string): Promise<string | null> {
  if (!remoteRuntimes.includes(kind)) return null;
  for (const host of await readHosts(file).catch(() => [])) {
    if (!host.sessions || live().filter(target => target === host.target).length >= host.sessions) continue;
    // A shim older than sessions takes shards only, until prepare runs there again.
    const probe = await probeHost(host.target, run);
    if (probe.ok && probe.verbs?.includes('run-session:1')) return host.target;
  }
  return null;
}
