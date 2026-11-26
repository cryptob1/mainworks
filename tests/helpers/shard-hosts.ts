// GY-3412: hosts for remote shard runs. Every host runs the real graphyard-host-shim, exactly as
// `mainworks host prepare` installs it, in its own home; only Docker is a stand-in, keeping its images
// and containers in a state file, logging each call, and running a container's command in its working
// directory — under `unshare -cn` (no network, nonroot as `--user 1000:0`) when it was created with --network=none, and with a
// read-only root (bubblewrap) on a host whose Docker state holds a `read-only-root` file. This machine
// has the same stand-in Docker. `ssh` here routes USER@NAME to the host named NAME (exit 255 while
// NAME.down exists, as OpenSSH does for a host it cannot reach); `sshd` runs a real OpenSSH server.
// GY-3645: `docker compose` reads a Compose file written as JSON: `up` starts a TCP listener on 127.0.0.1 for
// each named service's first `expose` port (it fails while the state holds `compose-up-fails`), `down` stops
// them, and a container created on a service's network resolves the project's service names to this machine.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freePort } from './http-server.js';
import { temporaryDirectory } from './temp-dirs.js';
import { hostShimScript } from '../../src/host-shim.js';
import { helperSigner } from '../../src/hosts.js';

const executable = async (path: string, text: string) => { await writeFile(path, text); await chmod(path, 0o755); };

/** A Docker CLI keeping its state under `state`. */
const dockerStandIn = (state: string) => `#!/usr/bin/python3
import fcntl, hashlib, io, json, os, re, shutil, subprocess, sys, tarfile
STATE = ${JSON.stringify(state)}
args = sys.argv[1:]
if args[:1] == ['--host']:
    args = args[2:]
os.makedirs(STATE, exist_ok=True)
lock = open(os.path.join(STATE, 'lock'), 'w')
fcntl.flock(lock, fcntl.LOCK_EX)
path = os.path.join(STATE, 'state.json')
s = json.load(open(path)) if os.path.exists(path) else {'images': {}, 'image_ids': [], 'containers': {}, 'warm': {}, 'deps': {}}
s.setdefault('warm', {})
s.setdefault('deps', {})
s.setdefault('image_ids', list(set(s['images'].values())))
def save():
    json.dump(s, open(path, 'w'))
def log(word):
    open(os.path.join(STATE, 'calls.log'), 'a').write(word + '\\n')
command = args[0]
open(os.path.join(STATE, 'every-call.log'), 'a').write(command + '\\n')
if command == 'compose':
    s.setdefault('projects', {})
    flag = lambda name: args[args.index(name) + 1] if name in args else None
    project, file = flag('-p'), flag('-f')
    verb = next(word for word in args[1:] if word in ('version', 'config', 'up', 'ps', 'down'))
    if verb == 'version':
        print('2.fixture')
    elif verb == 'config':
        print(open(file).read())
    elif verb == 'up':
        if os.path.exists(os.path.join(STATE, 'compose-up-fails')):
            sys.exit('Error response from daemon: fixture refuses to start services')
        names = args[args.index('--quiet-pull') + 1:]
        listen = "import socket, sys; s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen()\\nwhile True: s.accept()[0].close()"
        declared = json.load(open(file))['services']
        unpullable_path = os.path.join(STATE, 'unpullable-images')
        if os.path.exists(unpullable_path):
            unpullable = set(line.strip() for line in open(unpullable_path) if line.strip())
            for name in names:
                img = declared.get(name, {}).get('image')
                if img and img not in s['images'] and ('*' in unpullable or img in unpullable):
                    sys.exit("Error response from daemon: pull access denied for " + img + ", repository does not exist or may require 'docker login'")
        s['projects'][project] = {name: subprocess.Popen([sys.executable, '-c', listen, str(declared[name]['expose'][0])], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True).pid for name in names}
        log('compose up ' + ' '.join(names))
        save()
    elif verb == 'ps':
        if args[-1] in s['projects'].get(project, {}):
            print(project + '.' + args[-1])
    elif verb == 'down':
        for pid in s['projects'].pop(project, {}).values():
            try:
                os.kill(pid, 9)
            except OSError:
                pass
        log('compose down')
        save()
elif command == 'info':
    print('fixture')
elif command == 'ps':
    pass
elif command == 'images':
    repo = args[1] if len(args) > 1 and not args[1].startswith('-') else None
    for name in reversed(list(s['images'].keys())):
        if repo is None or name.split(':', 1)[0] == repo:
            print(name)
elif command == 'build':
    log('build')
    tag = args[args.index('-t') + 1]
    digest = 'sha256:' + hashlib.sha256((tag + ':' + str(len(s['image_ids']))).encode()).hexdigest()
    s['images'][tag] = digest
    if digest not in s['image_ids']:
        s['image_ids'].append(digest)
    save()
elif command == 'image':
    if len(args) > 1 and args[1] == 'rm':
        for name in args[2:]:
            s['images'].pop(name, None)
            s['warm'].pop(name, None)
            if name in s['image_ids']:
                s['image_ids'].remove(name)
                for key in [k for k, v in s['images'].items() if v == name]:
                    s['images'].pop(key, None)
        save()
    else:
        name = args[-1]
        if name in s['images']:
            print(s['images'][name])
        elif name in s['images'].values() or name in s['image_ids']:
            print(name)
        else:
            sys.exit('Error: No such image: ' + name)
elif command == 'tag':
    src = s['images'].get(args[1], args[1] if (args[1] in s['images'].values() or args[1] in s['image_ids']) else None)
    if src is None:
        sys.exit('Error: No such image: ' + args[1])
    s['images'][args[2]] = src
    if args[1] in s['warm']:
        s['warm'][args[2]] = s['warm'][args[1]]
    save()
elif command == 'save':
    log('save')
    print(json.dumps({'name': args[-1], 'id': s['images'][args[-1]], 'warm': s['warm'].get(args[-1]), 'deps': s['deps'].get(args[-1])}))
elif command == 'load':
    log('load')
    data = json.loads(sys.stdin.read())
    s['images'][data['name']] = data['id']
    if data['id'] not in s['image_ids']:
        s['image_ids'].append(data['id'])
    if data.get('warm') and os.path.isdir(data['warm']):
        dest = os.path.join(STATE, 'warm', hashlib.sha256(data['name'].encode()).hexdigest()[:16])
        if os.path.exists(dest):
            shutil.rmtree(dest)
        shutil.copytree(data['warm'], dest, symlinks=True)
        # Stand-in Docker has no container rootfs, so /warm/dist/cli.mjs would change path across
        # host state dirs; keep dist/ pointing at the warmed realpath just as /warm/dist does in Docker.
        for entry in ('cli.mjs', 'server.mjs'):
            src = os.path.realpath(os.path.join(data['warm'], 'dist', entry))
            dst = os.path.join(dest, 'dist', entry)
            if os.path.isfile(src) and os.path.exists(dst):
                os.unlink(dst)
                os.symlink(src, dst)
        s['warm'][data['name']] = dest
    if data.get('deps') and os.path.isdir(data['deps']):
        s['deps'][data['name']] = data['deps']
    save()
elif command == 'run':
    log('install')
    data = sys.stdin.buffer.read()
    name = args[args.index('--name') + 1]
    warm_dir = None
    base = args[args.index('--entrypoint') + 2] if '--entrypoint' in args else None
    if '/warm/harness' in ' '.join(args):
        # GY-3907: a catalog image: the base image's warm folder with the runner's files under harness/.
        warm_dir = os.path.join(STATE, 'containers', name, 'warm')
        if s['warm'].get(base) and os.path.isdir(s['warm'][base]):
            shutil.copytree(s['warm'][base], warm_dir, symlinks=True)
        os.makedirs(os.path.join(warm_dir, 'harness'), exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as tar:
            tar.extractall(os.path.join(warm_dir, 'harness'))
        s['containers'][name] = {'warm': warm_dir, 'deps': s['deps'].get(base) or os.environ.get('GRAPHYARD_STANDIN_NODE_MODULES')}
        save()
        sys.exit(0)
    if data:
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as tar:
                names = tar.getnames()
                if 'bin/built-entry.mjs' in names:
                    cdir = os.path.join(STATE, 'containers', name)
                    build = os.path.join(cdir, 'build')
                    warm_dir = os.path.join(cdir, 'warm')
                    os.makedirs(build, exist_ok=True)
                    os.makedirs(os.path.join(warm_dir, 'dist'), exist_ok=True)
                    os.makedirs(os.path.join(warm_dir, 'compile-cache'), exist_ok=True)
                    tar.extractall(build)
                    nm = os.environ.get('GRAPHYARD_STANDIN_NODE_MODULES')
                    if nm and os.path.isdir(nm):
                        if not os.path.lexists(os.path.join(build, 'node_modules')):
                            os.symlink(nm, os.path.join(build, 'node_modules'))
                        if not os.path.lexists(os.path.join(warm_dir, 'node_modules')):
                            os.symlink(nm, os.path.join(warm_dir, 'node_modules'))
                    subprocess.check_call(['node', 'bin/built-entry.mjs'], cwd=build)
                    for entry in ('cli.mjs', 'server.mjs'):
                        src = os.path.join(build, 'dist', entry)
                        if os.path.isfile(src):
                            dst = os.path.join(warm_dir, 'dist', entry)
                            shutil.move(src, dst)
                            os.symlink(dst, src)
                    m = re.search(r"printf '%s\\\\n' '?([0-9a-f]{40})'? > /warm/commit", ' '.join(args))
                    if m:
                        open(os.path.join(warm_dir, 'commit'), 'w').write(m.group(1) + '\\n')
                    subprocess.check_call(['node', 'bin/graphyard.mjs', '--help'], cwd=build, stdout=subprocess.DEVNULL,
                                          env={**os.environ, 'NODE_COMPILE_CACHE': os.path.join(warm_dir, 'compile-cache')})
                    shutil.rmtree(build, ignore_errors=True)
        except tarfile.TarError:
            pass
    s['containers'][name] = {'warm': warm_dir, 'deps': os.environ.get('GRAPHYARD_STANDIN_NODE_MODULES')}
    save()
elif command == 'commit':
    log('commit')
    cname, tag = args[-2], args[-1]
    s['images'][tag] = 'sha256:' + hashlib.sha256(tag.encode()).hexdigest()
    warm_dir = s['containers'].get(cname, {}).get('warm')
    if warm_dir and os.path.isdir(warm_dir):
        dest = os.path.join(STATE, 'warm', hashlib.sha256(tag.encode()).hexdigest()[:16])
        if os.path.exists(dest):
            shutil.rmtree(dest)
        shutil.copytree(warm_dir, dest, symlinks=True)
        for entry in ('cli.mjs', 'server.mjs'):
            src = os.path.realpath(os.path.join(warm_dir, 'dist', entry))
            dst = os.path.join(dest, 'dist', entry)
            if os.path.isfile(src) and os.path.exists(dst):
                os.unlink(dst)
                os.symlink(src, dst)
        s['warm'][tag] = dest
    deps_dir = s['containers'].get(cname, {}).get('deps')
    if deps_dir and os.path.isdir(deps_dir):
        s['deps'][tag] = deps_dir
    save()
elif command == 'rm':
    for name in args[1:]:
        s['containers'].pop(name, None)
    save()
elif command == 'create':
    at = args.index('--entrypoint')
    env = dict(value.split('=', 1) for flag, value in zip(args, args[1:]) if flag == '--env')
    # Loopback needs a capability to come up; bubblewrap refuses to start holding one, so the ambient set is cleared before the command runs.
    lo_up = "import ctypes, fcntl, os, socket, struct, sys; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); fcntl.ioctl(s, 0x8914, struct.pack('16sH', b'lo', 1)); s.close(); ctypes.CDLL(None).prctl(47, 4, 0, 0, 0); os.execvp(sys.argv[1], sys.argv[1:])"
    workdir, isolate = args[args.index('--workdir') + 1], ['unshare', '-cn', '--keep-caps', sys.executable, '-c', lo_up] if '--network=none' in args else []
    joined = next((word[len('--network=container:'):].split('.')[0] for word in args if word.startswith('--network=container:')), None)
    if joined:
        # glibc resolves each of the project's service names to this machine through HOSTALIASES.
        env['HOSTALIASES'] = os.path.join(STATE, 'aliases-' + joined)
        with open(env['HOSTALIASES'], 'w') as aliases:
            aliases.write(''.join(name + ' localhost\\n' for name in s.get('projects', {}).get(joined, {})))
    image_name = args[at + 2]
    warm_dir = s['warm'].get(image_name)
    if warm_dir and os.path.isdir(warm_dir):
        env['GRAPHYARD_WARM_DIR'] = warm_dir
        if os.path.isdir(os.path.join(warm_dir, 'compile-cache')) and 'NODE_COMPILE_CACHE' not in env:
            env['NODE_COMPILE_CACHE'] = os.path.join(warm_dir, 'compile-cache')
    if '--read-only' in args and os.path.exists(os.path.join(STATE, 'read-only-root')):
        # Docker's --read-only, for a host that asks: only the container's tmpfs and bind mounts are writable.
        isolate = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'] + (['--unshare-net'] if isolate else [])
        for flag, value in zip(args, args[1:]):
            if flag == '--tmpfs':
                isolate += ['--tmpfs', value.split(':')[0]]
            if flag == '--mount':
                mount = dict(part.split('=', 1) for part in value.split(',') if '=' in part)
                isolate += ['--ro-bind' if value.endswith(',readonly') else '--bind', mount['src'], mount['dst']]
        isolate += ['--chdir', workdir, '--']
    s['containers'][args[args.index('--name') + 1]] = {'workdir': workdir, 'env': env, 'image': image_name, 'deps': s['deps'].get(image_name), 'command': isolate + [args[at + 1]] + args[at + 3:]}
    open(os.path.join(STATE, 'creates.jsonl'), 'a').write(json.dumps(sys.argv[1:]) + '\\n')
    save()
elif command == 'start':
    container = s['containers'][args[-1]]
    nm = container.get('deps') or os.environ.get('GRAPHYARD_STANDIN_NODE_MODULES')
    nm_link = os.path.join(container['workdir'], 'node_modules')
    if nm and os.path.isdir(nm) and os.path.islink(nm_link) and os.readlink(nm_link) == '/deps/node_modules':
        os.unlink(nm_link)
        os.symlink(nm, nm_link)
    fcntl.flock(lock, fcntl.LOCK_UN)
    sys.exit(subprocess.call(container['command'], cwd=container['workdir'], env=container['env']))
`;

/** GY-3879: a shim as these hosts install it: the signers prepare records root-owned live in the fixture root, holding this machine's signing key. */
export const fixtureShim = (script: string, root: string) => {
  writeFileSync(join(root, 'mainworks-helper-signers'), `mainworks-helper namespaces="mainworks-helper" ${helperSigner()}\n`);
  return script.replaceAll('/etc/ssh/graphyard_helper_signers', join(root, 'mainworks-helper-signers'));
};

export interface ShardHostsFixture { root: string; bin: string; shim: string; localState: string; home(name: string): string; state(name: string): string; down(name: string, down: boolean): Promise<void> }

/** Hosts `names`, each with its own home and Docker state, reached as gy-compute@NAME through the ssh on `bin`; this machine's Docker holds `images` (name to id). */
export async function shardHosts(label: string, names: string[], images: Record<string, string> = {}): Promise<ShardHostsFixture> {
  const root = await temporaryDirectory(label), bin = join(root, 'bin'), shim = join(root, 'graphyard-host-shim'), localState = join(root, 'local-docker');
  await mkdir(bin, { recursive: true });
  await executable(shim, fixtureShim(hostShimScript, root));
  await executable(join(bin, 'docker'), dockerStandIn(localState));
  await mkdir(localState);
  await writeFile(join(localState, 'state.json'), JSON.stringify({ images, containers: {} }));
  for (const name of names) {
    await mkdir(join(root, 'hosts', name, 'home'), { recursive: true }); await mkdir(join(root, 'hosts', name, 'bin'));
    await executable(join(root, 'hosts', name, 'bin', 'docker'), dockerStandIn(join(root, 'hosts', name, 'docker')));
  }
  await executable(join(bin, 'ssh'), `#!/bin/sh
if [ "$1" = -G ]; then exec /usr/bin/ssh "$@"; fi
for arg; do case "$arg" in -fNM|-O) exit 0;; esac; done
for last; do :; done
for arg; do case "$arg" in *@*) target="$arg";; esac; done
host="\${target#*@}"; dir="${root}/hosts/$host"
if [ ! -d "$dir" ] || [ -e "$dir.down" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
cd "$dir/home" && export HOME="$dir/home" PATH="$dir/bin:/usr/bin:/bin" GRAPHYARD_HOST_FLOOR_GB=0
# GY-3834: FAKE_SSH_KEY names another install's key, which reaches only the command its authorized_keys line forces.
if [ -n "$FAKE_SSH_KEY" ]; then
  line=$(grep -F "$FAKE_SSH_KEY" "$HOME/.ssh/authorized_keys" 2>/dev/null | head -n 1)
  [ -n "$line" ] || { echo "gy-compute@$host: Permission denied (publickey)." >&2; exit 255; }
  export SSH_ORIGINAL_COMMAND="$last"
  PATH="${root}:$PATH" exec sh -c "$(printf %s "$line" | sed 's/^restrict,command="\\([^"]*\\)".*/\\1/')"
fi
SSH_ORIGINAL_COMMAND="$last" exec "${shim}"
`);
  return {
    root, bin, shim, localState,
    home: name => join(root, 'hosts', name, 'home'),
    state: name => join(root, 'hosts', name, 'docker'),
    down: async (name, down) => { if (down) await writeFile(join(root, 'hosts', `${name}.down`), ''); else await import('node:fs/promises').then(fs => fs.rm(join(root, 'hosts', `${name}.down`), { force: true })); },
  };
}

export const dockerCalls = (state: string) => existsSync(join(state, 'calls.log')) ? execFileSync('cat', [join(state, 'calls.log')], { encoding: 'utf8' }).split('\n').filter(Boolean) : [];
/** Every Docker call the host made, by its command word. */
export const dockerEveryCall = (state: string) => existsSync(join(state, 'every-call.log')) ? readFileSync(join(state, 'every-call.log'), 'utf8').split('\n').filter(Boolean) : [];
export const dockerCount = (state: string, word: string) => dockerCalls(state).filter(entry => entry === word).length;
export const dockerCreates = async (state: string): Promise<string[][]> => existsSync(join(state, 'creates.jsonl'))
  ? (await readFile(join(state, 'creates.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
export const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

/** A repository whose test runner runs the files its list names, writes one record per file (a file named `fails` fails), and prints the checkout's commit count. */
const shardRunner = `import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const at = name => process.argv[process.argv.indexOf(name) + 1];
const files = readFileSync(at('--files-from'), 'utf8').split('\\n').filter(Boolean);
console.log('history ' + execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
let failed = 0;
for (const file of files) {
  if (file.includes('dies')) process.exit(137);
  const passed = !file.includes('fails'); failed += passed ? 0 : 1;
  appendFileSync(at('--durations'), JSON.stringify({ file, passed, durationMs: 1 }) + '\\n');
  console.log((passed ? 'ok ' : 'not ok ') + file + ' in ' + process.cwd());
}
process.exit(failed ? 1 : 0);
`;
export async function shardRepository(label: string, files: readonly string[], extra: Record<string, string> = {}) {
  const root = await temporaryDirectory(label);
  git(root, 'init', '-q', '-b', 'main');
  const content: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'true' } }),
    'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }),
    'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'test', command: 'node scripts/tests.mjs', source: 'script', reason: 'fixture', selection: { command: 'node scripts/select.mjs', pattern: '^tests/[\\w./-]+\\.test\\.ts$' } }] } } }),
    'scripts/select.mjs': '', 'scripts/tests.mjs': shardRunner,
    ...Object.fromEntries(files.map(file => [file, 'fixture\n'])),
    ...extra,
  };
  for (const [path, text] of Object.entries(content)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
  return { root, sha: git(root, 'rev-parse', 'HEAD') };
}
export const commitFile = async (root: string, path: string, text: string) => { await writeFile(join(root, path), text); git(root, 'add', '-A'); git(root, 'commit', '-qm', `change ${path}`); return git(root, 'rev-parse', 'HEAD'); };

/** Kill every process under the ones `matches` picks (by working directory: the shim execs python, so its command line names no path), and those too. */
export function killTrees(matches: (pid: number, cwd: string) => boolean) {
  const table = readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
    try { return [{ pid: Number(pid), ppid: Number(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1]), cwd: readlinkSync(`/proc/${pid}/cwd`) }]; } catch { return []; }
  });
  const tree = new Set(table.filter(entry => matches(entry.pid, entry.cwd)).map(entry => entry.pid));
  for (let grew = true; grew;) { grew = false; for (const { pid, ppid } of table) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/**
 * A real OpenSSH server on 127.0.0.1 for this user, whose only key may run the shim with `home` as the
 * host's own folder and `hostBin` (its Docker) first on PATH (restrict,command=…, as `mainworks host prepare` writes it), and an `ssh` on `bin`
 * that reaches it as USER@127.0.0.1 with that key. `kill` drops the host mid-run.
 */
export async function sshdHost(root: string, shim: string, home: string, hostBin: string, bin: string) {
  const dir = join(root, 'sshd'), port = await freePort();
  await mkdir(dir, { recursive: true }); await mkdir(home, { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'client')]);
  const key = (await readFile(join(dir, 'client.pub'), 'utf8')).trim();
  await writeFile(join(dir, 'authorized_keys'), `restrict,command="GRAPHYARD_HOST_FLOOR_GB=0 PATH=${hostBin}:/usr/bin:/bin ${shim} --home ${home}" ${key}\n`);
  await writeFile(join(dir, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host')}`, `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
    `PidFile ${join(dir, 'pid')}`, 'UsePAM no', 'StrictModes no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitUserEnvironment no', ''].join('\n'));
  const sshd = execFileSync('sh', ['-c', 'command -v sshd || echo /usr/sbin/sshd'], { encoding: 'utf8' }).trim();
  let server: ChildProcess | null = null;
  const start = async () => {
    const child = spawn(sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    server = child;
    await new Promise<void>((resolve, reject) => {
      let stderr = '', settled = false;
      const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => done(new Error(`sshd did not listen: ${stderr.trim()}`)), 5_000);
      // Wait for sshd's own listening line (and keep stderr drained) instead of probing by binding `port`, which races sshd's bind().
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderr += chunk.toString('utf8');
        if (stderr.includes(`Server listening on 127.0.0.1 port ${port}.`)) done();
      });
      child.once('error', error => done(error));
      child.once('exit', (code, signal) => done(new Error(`sshd exited before listening (${signal ?? code}): ${stderr.trim()}`)));
    });
  };
  await start();
  const real = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
  await executable(join(bin, 'ssh'), `#!/bin/sh\nexec ${real} -i ${join(dir, 'client')} -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$@"\n`);
  /** Every process the server started — its sessions, the shim, the launcher and the shard — then the server itself: the host drops off. */
  const kill = () => killTrees(pid => pid === server?.pid);
  return { port, user: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), start, kill };
}
