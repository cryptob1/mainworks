// Concern: GY-3412 — graphyard-host-shim, the only command this machine's SSH key may run on a host
// (authorized_keys restrict,command=…, written by `graphyard host prepare`). It runs as the host's
// unprivileged gy-compute user with rootless Docker and answers fixed verbs with validated arguments:
//   probe                          the shim's own digest and verbs (GY-3517), then cores, load, CPU steal, sensors and running trial containers
//   receive-pack REPO SHA          a git pack on stdin into the per-repo mirror ~/.graphyard/mirrors/REPO.git
//   receive-image IMAGE            `docker save` output on stdin, loaded once per warm image; older warm images go
//   prepare-run REPO SHA IMAGE     a checkout of SHA cloned from the mirror under ~/.graphyard/runs,
//                                  or `need-pack LAST` / `need-image` when the host lacks either
//   run-shard RUN INDEX            JSON {files, argv, cpus, deadline} on stdin, nothing else; the trial launcher runs argv
//                                  in IMAGE with --network=none, CPU, memory and process limits, only RUN mounted
//   fetch-records RUN INDEX        the shard's per-file records
//   run-check RUN                  JSON {file, services, argv, cpus, deadline} on stdin (GY-3645): the commit's own Compose file
//                                  started as one project, argv run by the trial launcher on its first service's network
//                                  with the services' variables, the project and its volumes removed whatever argv answered
//   clean RUN                      remove a run directory
//   run-session RUN                GY-3405: one agent session in IMAGE with RUN's checkout mounted at the session's own
//                                  working directory; the first stdin line is JSON {argv, env, cwd, homes}, nothing else,
//                                  each home an in-memory tmpfs; the rest of stdin (the login) goes straight into the container;
//                                  no Docker log, a memory limit, a deadline, and a guardian that removes the container
// Anything else is refused. As in a local trial, containers may start nested sandboxes (seccomp and system
// paths unconfined, the graphyard-trial AppArmor profile where Docker uses AppArmor; GY-3549), and never
// get the Docker socket, so a shard, which has no network either, reaches no private address, the tailnet or the host.
// A check's Compose project may reach no host path outside its run directory, nor any host namespace, device or capability.
import { createHash } from 'node:crypto';
import { trialLauncher } from './merge-writer/trial-container.js';
import { trialAppArmorProfile } from './merge-writer/trial-apparmor.js';
import { defaultDiskFloorGb, minimumTrialContainers, trialHotCelsius, trialPressureBoundSeconds, trialStartOrder } from './merge-writer/trial-load.js';

/** Read-only: Docker's answer, cores, load, the /proc/stat cpu line, CPU sensors and the trial containers running now. */
export const hostProbeScript = [
  'docker info --format "{{.ID}}" >/dev/null 2>&1 || { echo graphyard-no-docker; exit 0; }',
  'echo "cores $(nproc)"',
  'echo "load $(cut -d " " -f 1 /proc/loadavg)"',
  'head -n 1 /proc/stat',
  'for d in /sys/class/hwmon/hwmon*; do n=$(cat "$d/name" 2>/dev/null); for t in "$d"/temp*_input; do [ -r "$t" ] && echo "temp $n $(cat "$t")"; done; done',
  'echo "runs $(docker ps -q --filter name=^graphyard-trial- | wc -l)"',
].join('\n');

/** The warm image a host runs shards in: the trial image's digest and the lockfile's hash (`none` without one). */
export const warmImagePattern = /^graphyard-warm:[0-9a-f]{12}-(?:[0-9a-f]{12}|none)$/;

/** GY-3405: no agent session runs longer on a host; Graphyard ends every session well before. */
const sessionHours = 8;
/**
 * GY-3517: the verbs this shim speaks, each with a revision. Bump a verb's revision when a release
 * changes what it does in a way a trial relies on, and add a new verb here; any other change to the
 * shim (its launcher, limits, wording) leaves this list alone, so hosts on the older shim keep taking shards.
 */
export const hostShimVerbs = ['probe:1', 'receive-pack:1', 'receive-image:1', 'prepare-run:1', 'run-shard:2', 'fetch-records:1', 'clean:1', 'run-session:1'];
/** GY-3645: `run-check` is no trial verb: a host takes a whole check once its probe names a Compose plugin, which only a shim with the verb prints. */
/** The verbs a merge trial uses: a host whose shim lacks any of them takes no shards until prepare runs again there. */
export const trialVerbs = hostShimVerbs.filter(verb => !verb.startsWith('run-session:'));
/** Shims released before the probe listed its verbs, by digest: the verbs each speaks (GY-3549's shim). */
export const legacyShimVerbs: Record<string, readonly string[]> = { '90b5bdaa66f84f53f7dbc87ef089f17051c1e230900a4248ffb76ecb8d2315d6': trialVerbs };
/** The trial verbs a shim lacks, by what its probe printed: its verbs line, else what its digest is known to speak. */
export const missingTrialVerbs = (probe: { shim: string | null; verbs: string[] | null }) => {
  const speaks = probe.verbs ?? (probe.shim === hostShimDigest ? hostShimVerbs : probe.shim ? legacyShimVerbs[probe.shim] : undefined) ?? [];
  return trialVerbs.filter(verb => !speaks.includes(verb));
};

const shimDigestSlot = '@GRAPHYARD_SHIM_DIGEST@';
const shimTemplate = `#!/bin/sh
# graphyard-host-shim: the only command Graphyard's SSH key may run here (graphyard host prepare).
refuse() { echo "graphyard-host-shim refuses: $SSH_ORIGINAL_COMMAND" >&2; exit 1; }
[ $# -eq 0 ] || { [ $# -eq 2 ] && [ "$1" = --home ]; } || refuse
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
case "$SSH_ORIGINAL_COMMAND" in
  probe)
    echo "shim ${shimDigestSlot}"
    echo "verbs ${hostShimVerbs.join(' ')}"
    echo "user $(id -u) $(id -Gn)"
    echo "compose $(docker compose version --short 2>/dev/null)"
${hostProbeScript.split('\n').map(line => `    ${line}`).join('\n')}
    ;;
  receive-pack\\ *|receive-image\\ *|prepare-run\\ *|run-shard\\ *|run-check\\ *|fetch-records\\ *|clean\\ *|run-session\\ *)
    # The verbs that take arguments, validated and run in Python.
    exec python3 -I -c "$(cat <<'GRAPHYARD_VERBS'
import json, os, re, shutil, signal, subprocess, sys, tempfile, time
LAUNCHER = ${JSON.stringify(trialLauncher)}
asked = os.environ.get('SSH_ORIGINAL_COMMAND', '')
def refuse():
    sys.stderr.write('graphyard-host-shim refuses: ' + asked + '\\n')
    sys.exit(1)
home = sys.argv[2] if len(sys.argv) == 3 else os.path.expanduser('~')
words = asked.split(' ')
verb, args = words[0], words[1:]
NAME = r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}'
SHA = r'[0-9a-f]{40}(?:[0-9a-f]{24})?'
RUN = r'trial-[A-Za-z0-9_]{6,40}'
IMAGE = ${JSON.stringify(warmImagePattern.source.slice(1, -1))}
INDEX = r'[1-9][0-9]{0,3}'
SHAPES = {'receive-pack': [NAME, SHA], 'receive-image': [IMAGE], 'prepare-run': [NAME, SHA, IMAGE],
          'run-shard': [RUN, INDEX], 'run-check': [RUN], 'fetch-records': [RUN, INDEX], 'clean': [RUN], 'run-session': [RUN]}
if verb not in SHAPES or len(args) != len(SHAPES[verb]) or not all(re.fullmatch(shape, arg) for shape, arg in zip(SHAPES[verb], args)):
    refuse()
mirrors, runs = os.path.join(home, '.graphyard', 'mirrors'), os.path.join(home, '.graphyard', 'runs')
def quiet(*command, **options):
    return subprocess.call(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options) == 0
def has_image(image):
    return quiet('docker', 'image', 'inspect', image)
if verb in ('receive-pack', 'prepare-run'):
    mirror = os.path.join(mirrors, args[0] + '.git')
    if not os.path.isdir(mirror):
        os.makedirs(mirrors, exist_ok=True)
        subprocess.check_call(['git', 'init', '-q', '--bare', mirror])
    def has_commit(sha):
        return quiet('git', '--git-dir=' + mirror, 'cat-file', '-e', sha + '^{commit}')
if verb == 'receive-pack':
    subprocess.check_call(['git', '--git-dir=' + mirror, 'index-pack', '--stdin'], stdout=subprocess.DEVNULL)
    if not has_commit(args[1]):
        sys.exit('graphyard-host-shim: the pack does not hold ' + args[1])
    subprocess.check_call(['git', '--git-dir=' + mirror, 'update-ref', 'refs/graphyard/last', args[1]])
    quiet('git', '--git-dir=' + mirror, 'gc', '--auto', '-q')
elif verb == 'receive-image':
    subprocess.check_call(['docker', 'load', '-q'], stdout=subprocess.DEVNULL)
    if not has_image(args[0]):
        sys.exit('graphyard-host-shim: the image stream does not hold ' + args[0])
    # One warm image is kept: the others go unless a running shard still uses one.
    for image in subprocess.run(['docker', 'images', 'graphyard-warm', '--format', '{{.Repository}}:{{.Tag}}'], capture_output=True, text=True).stdout.split():
        if image != args[0]:
            quiet('docker', 'image', 'rm', image)
elif verb == 'prepare-run':
    if not has_commit(args[1]):
        last = subprocess.run(['git', '--git-dir=' + mirror, 'rev-parse', '-q', '--verify', 'refs/graphyard/last'], capture_output=True, text=True).stdout.strip()
        print('need-pack ' + (last or '-'))
        sys.exit(0)
    if not has_image(args[2]):
        print('need-image')
        sys.exit(0)
    os.makedirs(runs, exist_ok=True)
    # Run directories a killed trial left behind over a day ago go first.
    for name in os.listdir(runs):
        if re.fullmatch(RUN, name) and time.time() - os.path.getmtime(os.path.join(runs, name)) > 86400:
            shutil.rmtree(os.path.join(runs, name), ignore_errors=True)
    run = tempfile.mkdtemp(prefix='trial-', dir=runs)
    checkout = os.path.join(run, 'repo')
    # Keep history, but copy objects: per-run permissions must never change the mirror.
    subprocess.check_call(['git', 'clone', '-q', '--local', '--no-hardlinks', '--no-checkout', mirror, checkout])
    subprocess.check_call(['git', '-C', checkout, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', args[1]])
    if not args[2].endswith('-none') and not os.path.lexists(os.path.join(checkout, 'node_modules')):
        os.symlink('/deps/node_modules', os.path.join(checkout, 'node_modules'))
    with open(os.path.join(run, 'image'), 'w') as file:
        file.write(args[2])
    # Container GID 0 maps to the host user's group under rootless Docker. Only this
    # run is writable by that group; UID 1000 can start Postgres without being root.
    for directory, dirs, files in os.walk(run):
        os.chmod(directory, os.stat(directory).st_mode | 0o2070)
        for name in files:
            path = os.path.join(directory, name)
            if not os.path.islink(path):
                os.chmod(path, os.stat(path).st_mode | 0o060)
    print('run ' + os.path.basename(run))
elif verb == 'run-session':
    # Only the first line is the shim's: read unbuffered, so the login after it reaches the container's stdin and never a file here.
    line = b''
    while not line.endswith(b'\\n'):
        byte = os.read(0, 1)
        if not byte:
            break
        line += byte
    try:
        session = json.loads(line)
    except ValueError:
        refuse()
    if not isinstance(session, dict) or set(session) != {'argv', 'env', 'cwd', 'homes'}:
        refuse()
    argv, env, cwd, homes = session['argv'], session['env'], session['cwd'], session['homes']
    path = lambda value: isinstance(value, str) and re.fullmatch(r'/[A-Za-z0-9._/@+-]{1,400}', value) and '..' not in value.split('/')
    if not (isinstance(argv, list) and 0 < len(argv) <= 5000 and all(isinstance(word, str) and '\\0' not in word for word in argv)) or not path(cwd) \\
            or not (isinstance(homes, list) and len(homes) <= 20 and all(path(home) for home in homes)) \\
            or not (isinstance(env, dict) and len(env) <= 200 and all(re.fullmatch(r'[A-Z_][A-Z0-9_]{0,99}', key) and isinstance(value, str) and not set('\\0\\n') & set(value) for key, value in env.items())):
        refuse()
    run = os.path.join(runs, args[0])
    if not os.path.isdir(run):
        sys.exit('graphyard-host-shim: no run ' + args[0])
    name = 'graphyard-session-' + args[0][len('trial-'):]
    # The network is the default one: the session reaches its model provider and the control plane. Only the checkout is mounted; the root is
    # read-only, as a trial's is, and every home and /tmp is memory.
    # No log driver: the login handed back on stderr never reaches the host's disk. Half the host's memory at most.
    memory = next((int(line.split()[1]) for line in open('/proc/meminfo') if line.startswith('MemTotal:')), 4 << 20) // 1024 // 2
    create = ['docker', 'create', '-i', '--init', '--name', name, '--user', '1000:0', '--workdir', cwd, '--log-driver', 'none', '--memory', '%dm' % max(1024, memory),
              '--pids-limit', '4096',
              '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt', 'seccomp=unconfined', '--tmpfs', '/tmp:mode=1777']
    if 'apparmor' in subprocess.run(['docker', 'info', '--format', '{{json .SecurityOptions}}'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout:
        create += ['--security-opt', 'apparmor=${trialAppArmorProfile}']
    for home in homes:
        create += ['--tmpfs', home + ':uid=1000,gid=0,mode=0700']
    create += ['--mount', 'type=bind,src=' + os.path.join(run, 'repo') + ',dst=' + cwd]
    for key, value in sorted(env.items()):
        create += ['--env', key + '=' + value]
    # The session stops at its deadline on its own, even when no shim or guardian is left to remove it.
    create += ['--entrypoint', '/usr/bin/timeout', open(os.path.join(run, 'image')).read().strip(), '--kill-after=10', '${sessionHours}h'] + argv
    # A guardian outside this process tree removes the container once the shim is gone, however it ended (a dropped SSH session, a kill).
    reader, writer = os.pipe()
    if os.fork() == 0:
        os.close(writer)
        os.setsid()
        if os.fork() == 0:
            os.chdir('/')
            devnull = os.open(os.devnull, os.O_RDWR)
            for fd in (0, 1, 2):
                os.dup2(devnull, fd)
            os.read(reader, 1)
            quiet('docker', 'rm', '-f', name)
        os._exit(0)
    os.close(reader)
    os.wait()
    if not quiet(*create):
        sys.exit('graphyard-host-shim: the session container could not be created')
    try:
        code = subprocess.call(['docker', 'start', '-a', '-i', name])
    finally:
        quiet('docker', 'rm', '-f', name)
    sys.exit(code)
else:
    run = os.path.join(runs, args[0])
    project = 'graphyard-check-' + args[0][6:].lower()
    # A request names its files or Compose file, command, CPUs and deadline only: one asking for anything else (a mount, an image, a network) is refused.
    if verb in ('run-shard', 'run-check'):
        try:
            request = json.load(sys.stdin)
        except ValueError:
            refuse()
        if not isinstance(request, dict) or set(request) != ({'files', 'argv', 'cpus', 'deadline'} if verb == 'run-shard' else {'file', 'services', 'argv', 'cpus', 'deadline'}):
            refuse()
        argv, cpus, deadline = request['argv'], request['cpus'], request['deadline']
        strings = lambda values, forbidden: isinstance(values, list) and 0 < len(values) <= 5000 and all(isinstance(value, str) and not set(forbidden) & set(value) for value in values)
        if not strings(argv, '\\0') or type(cpus) is not int or type(deadline) is not int:
            refuse()
    if not os.path.isdir(run):
        sys.exit('graphyard-host-shim: no run ' + args[0])
    def launch(network, command, variables={}, **options):
        cores = os.cpu_count() or 1
        cap = max(2, max(${minimumTrialContainers}, cores // 2))
        memory = next((int(line.split()[1]) for line in open('/proc/meminfo') if line.startswith('MemTotal:')), 4 << 20) // 1024 // cap
        spec = {'image': open(os.path.join(run, 'image')).read().strip(), 'mounts': [[run, run, False]], 'network': network,
                'deadline': min(deadline, int(time.time() * 1000) + 3 * 3600 * 1000), 'docker': os.environ['DOCKER_HOST'], 'user': '1000:0',
                'limits': {'cpus': max(1, min(cpus, cores)), 'memory': '%dm' % max(512, memory), 'pids': 4096},
                'apparmor': '${trialAppArmorProfile}' if 'apparmor' in subprocess.run(['docker', 'info', '--format', '{{json .SecurityOptions}}'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout else None,
                'load': {'slots': os.path.join(home, '.gy', 'trial-slots'), 'cap': cap, 'order': ${trialStartOrder.merge}, 'hotCelsius': ${trialHotCelsius},
                         'floorBytes': float(os.environ.get('GRAPHYARD_HOST_FLOOR_GB', ${defaultDiskFloorGb})) * 1e9, 'hwmon': '/sys/class/hwmon', 'pressureBoundSeconds': ${trialPressureBoundSeconds}}}
        # Keep new files removable by the host's mapped group too.
        command = ['/bin/sh', '-c', 'umask 0002; exec "$@"', 'sh'] + command
        os.chdir(os.path.join(run, 'repo'))
        sys.stdout.flush()
        return subprocess.call([sys.executable, '-I', '-S', '-c', LAUNCHER, json.dumps(spec)] + command, **options,
                               env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': '/tmp', 'CI': '1', **variables,
                                    'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': os.getcwd()})
    if verb == 'clean':
        # A check the connection dropped under may have left its project up.
        if os.path.exists(os.path.join(run, 'compose-project')):
            quiet('docker', 'compose', '-p', project, 'down', '--volumes', '--remove-orphans', '--rmi', 'local', '--timeout', '5')
        shutil.rmtree(run, ignore_errors=True)
    elif verb == 'fetch-records':
        try:
            sys.stdout.write(open(os.path.join(run, 'tests-' + args[1] + '.jsonl')).read())
        except OSError:
            pass
    elif verb == 'run-shard':
        files = request['files']
        if not strings(files, '\\0\\n'):
            refuse()
        listed, records = os.path.join(run, 'tests-' + args[1] + '.txt'), os.path.join(run, 'tests-' + args[1] + '.jsonl')
        with open(listed, 'w') as file:
            file.write('\\n'.join(files) + '\\n')
        sys.exit(launch('none', [{'{list}': listed, '{records}': records}.get(word, word) for word in argv]))
    else:
        file, services = request['file'], request['services']
        if not isinstance(file, str) or not file or file.startswith('/') or '..' in file.split('/') or '\\0' in file or not isinstance(services, list) or not 0 < len(services) <= 8 \
                or not all(isinstance(entry, dict) and set(entry) == {'service', 'port'} and isinstance(entry['service'], str) and re.fullmatch(NAME, entry['service']) and type(entry['port']) is int for entry in services):
            refuse()
        # Only the Compose file this run's commit holds, unchanged, inside its checkout.
        repo = os.path.realpath(os.path.join(run, 'repo'))
        compose = os.path.realpath(os.path.join(repo, file))
        committed = subprocess.run(['git', '-C', repo, 'cat-file', 'blob', 'HEAD:' + file], capture_output=True)
        if not compose.startswith(repo + os.sep) or committed.returncode != 0 or not os.path.isfile(compose) or open(compose, 'rb').read() != committed.stdout:
            refuse()
        base = ['docker', 'compose', '-p', project, '--project-directory', os.path.dirname(compose), '--env-file', os.devnull, '-f', compose]
        # Compose reads include, extends and label files from anywhere before any configuration can be checked; an escape could spell those words.
        if re.search(r'\\b(?:include|extends|label_file)\\b|\\\\[xuU]', open(compose, errors='replace').read()):
            sys.exit('graphyard-host-shim refuses: ' + file + ' includes or extends other files, or writes a character by an escape')
        try:
            config = json.loads(subprocess.run(base + ['config', '--format', 'json'], capture_output=True, text=True).stdout)
        except ValueError:
            sys.exit('graphyard-host-shim: docker compose cannot read ' + file)
        # The host lends this run directory and nothing else: no host path outside it, no host namespace, device or
        # capability, and no volume, network, secret or config shared or driven from outside (compose-preview.ts holds a local check alike).
        within = lambda path: isinstance(path, str) and (os.path.realpath(os.path.join(os.path.dirname(compose), path)) + os.sep).startswith(os.path.realpath(run) + os.sep)
        problems = []
        for name, entry in (config.get('services') or {}).items():
            for volume in entry.get('volumes') or []:
                if volume.get('type') == 'bind' and not within(volume.get('source')):
                    problems.append('binds ' + str(volume.get('source')) + ', outside the run directory')
                elif volume.get('type') not in ('bind', 'volume', 'tmpfs'):
                    problems.append('service ' + name + ' mounts a ' + str(volume.get('type')) + ' volume')
            for env in entry.get('env_file') or []:
                if not within(env.get('path') if isinstance(env, dict) else env):
                    problems.append('service ' + name + ' reads an env file outside the run directory')
            for key in ('build', 'privileged', 'cap_add', 'devices', 'device_cgroup_rules', 'use_api_socket', 'volumes_from', 'external_links', 'security_opt', 'post_start', 'pre_stop', 'provider', 'runtime', 'storage_opt', 'credential_spec'):
                if entry.get(key):
                    problems.append('service ' + name + ' sets ' + key)
            for key in ('network_mode', 'pid', 'ipc', 'userns_mode', 'uts', 'cgroup'):
                if re.match('host|container:|service:', str(entry.get(key) or '')):
                    problems.append('service ' + name + ' shares the ' + key + ' ' + entry[key])
        for kind, default in (('volumes', 'local'), ('networks', 'bridge')):
            for name, entry in (config.get(kind) or {}).items():
                if entry and (entry.get('external') or entry.get('driver_opts') or entry.get('driver', default) != default):
                    problems.append(kind[:-1] + ' ' + name + ' is external or set by driver options')
        for kind in ('secrets', 'configs'):
            for name, entry in (config.get(kind) or {}).items():
                if entry and (entry.get('external') or entry.get('environment') or ('file' in entry and not within(entry['file']))):
                    problems.append(kind[:-1] + ' ' + name + ' reads from outside the run directory')
        if problems:
            sys.exit('graphyard-host-shim refuses: ' + file + ' ' + '; '.join(problems))
        names, steps = [entry['service'] for entry in services], []
        def stop(number, frame):
            raise SystemExit(128 + number)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGHUP, stop)
        open(os.path.join(run, 'compose-project'), 'w').close()
        try:
            at = time.time()
            up = subprocess.run(base + ['up', '-d', '--quiet-pull'] + names, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            container = subprocess.run(base + ['ps', '-q', names[0]], capture_output=True, text=True).stdout.split() if up.returncode == 0 else []
            if not container:
                sys.exit('graphyard-host-shim: the services did not start: ' + up.stdout[-500:])
            steps.append('services %d' % ((time.time() - at) * 1000))
            variables = {}
            for entry in services:
                name = 'GRAPHYARD_SERVICE_' + re.sub('[^A-Z0-9]', '_', entry['service'].upper())
                variables[name + '_HOST'], variables[name + '_PORT'] = entry['service'], str(entry['port'])
            at = time.time()
            status = launch('container:' + container[0], argv, variables, stderr=subprocess.STDOUT)
            steps.append('command %d' % ((time.time() - at) * 1000))
        finally:
            at = time.time()
            if quiet(*base, 'down', '--volumes', '--remove-orphans', '--rmi', 'local', '--timeout', '5'):
                os.remove(os.path.join(run, 'compose-project'))
            steps.append('teardown %d' % ((time.time() - at) * 1000))
        # The command's own exit travels as a line: this verb exits 0 whenever the command ran.
        print('\\n' + '\\n'.join('graphyard-check ' + step for step in steps) + '\\ngraphyard-check exit %d' % status)
GRAPHYARD_VERBS
)" "$@" ;;
  *) refuse ;;
esac
`;
/** GY-3476: this release's shim, named by the digest its probe prints; GY-3517: a host on another digest stays ready while it speaks every trial verb. */
export const hostShimDigest = createHash('sha256').update(shimTemplate).digest('hex');
export const hostShimScript = shimTemplate.replace(shimDigestSlot, hostShimDigest);
