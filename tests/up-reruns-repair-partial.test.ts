import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { runUp, type UpDependencies, type UpEvent, type UpRequest } from '../src/up.js';

// GY-4123: up checks each step's real result, not a stored flag. A run interrupted after the image
// step leaves a container behind; the rerun installs the control plane, points origin at the SSH
// form with core.sshCommand on the deploy key up created, fetches through it for real, creates
// deploy.env at 0600, and runs one contained npm ci on main. A later rerun leaves what answers alone
// and repairs a control plane that stopped answering whatever up.json records.

const SERVER = 'http://127.0.0.1:4310';
const request = (): UpRequest => ({ repository: 'owner/project', provider: 'compose', agent: false, master: 'claude' });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout, its GitHub stand-in (a bare repository) and an `ssh` that serves it only to the deploy key. */
async function fixture() {
  const base = await temporaryDirectory('up-reruns-repair-partial');
  const bare = join(base, 'remote.git'), root = join(base, 'checkout'), bin = join(base, 'bin'), install = join(base, 'config', 'mainworks', 'owner-project');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  await mkdir(root); git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'package.json'), '{"name":"project","version":"1.0.0"}\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git(root, 'push', '-q', bare, 'main');
  // gh repo create leaves origin at https; up must move it to the SSH form.
  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await mkdir(bin);
  // Serves the bare repository only when git passes `-i` with the deploy key up created.
  await writeFile(join(bin, 'ssh'), `#!/bin/sh
key=""; while [ $# -gt 1 ]; do case "$1" in -i) key="$2"; shift 2;; -o|-p) shift 2;; *) host="$1"; shift;; esac; done
[ -n "$REFUSE" ] && { echo "ERROR: Permission to owner/project denied to deploy key" >&2; exit 128; }
[ "$key" = "$EXPECTED_KEY" ] && [ -f "$key" ] || { echo "Permission denied (publickey)." >&2; exit 255; }
case "$1" in git-upload-pack*) exec git-upload-pack "$BARE";; esac
exit 1
`);
  await chmod(join(bin, 'ssh'), 0o755);
  return { base, bare, root, bin, install, key: join(install, 'deploy-key') };
}

/** A host whose install --apply builds the image, then starts the server container; the first one is interrupted after the image. */
function host(fx: Awaited<ReturnType<typeof fixture>>) {
  const state = { image: false, container: 'none' as 'none' | 'stopped' | 'running', applies: 0, interrupt: true, masterInit: false, refuse: false, npmCi: [] as string[], npmCiCode: 0 };
  const events: UpEvent[] = [];
  const env = () => ({ ...process.env, PATH: `${fx.bin}:${process.env.PATH}`, EXPECTED_KEY: fx.key, BARE: fx.bare, ...(state.refuse ? { REFUSE: '1' } : {}) });
  const deps: UpDependencies = {
    root: fx.root, pollMs: 1, emit: event => { events.push(event); }, now: () => 0, sleep: async () => {},
    serverUrl: async () => SERVER, masterToken: async () => 'm'.repeat(40), operatorToken: async () => 'a'.repeat(40),
    controlPlaneAnswers: async () => state.container === 'running',
    status: async () => state.container === 'running' && state.masterInit ? {
      fleet: { roles: [{ role: 'worker', accounts: ['claude-a'] }, { role: 'reviewer', accounts: ['claude-a'] }], accounts: [{ name: 'claude-a', enabled: true, loggedIn: true, eligible: true }] },
      serving: { onboarding: { onboarded: true, fault: null, features: [] } }, setup: { loop: true },
    } : null,
    publishOnboarding: async () => null,
    gh: async () => ({ code: 0, stdout: '{}' }),
    git: args => new Promise(accept => {
      const child = spawn('git', args, { cwd: fx.root, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => accept({ code: code ?? 1, stdout, stderr }));
    }),
    installDirectory: () => fx.install,
    ensureDeployKey: async directory => {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'deploy-key'), 'private key\n', { mode: 0o600 });
      return join(directory, 'deploy-key');
    },
    npmCi: async cwd => {
      state.npmCi.push(git(cwd, 'rev-parse', 'HEAD'));
      return { code: state.npmCiCode, command: `bwrap --ro-bind / / -- npm ci (in ${cwd})`, stderr: state.npmCiCode ? 'npm ERR! mise: No version is set for shim: node' : '' };
    },
    async cli(args) {
      if (args[0] === 'install' && args.includes('--plan')) return { code: 0, stdout: JSON.stringify({ preflight: [{ name: 'Docker', ok: true }] }) };
      if (args[0] === 'install' && args.includes('--apply')) {
        state.applies++;
        state.image = true;
        if (state.interrupt) { state.interrupt = false; state.container = 'stopped'; return { code: 130, stdout: '', stderr: 'interrupted after the image step' }; }
        // A leftover container is reused and started, never duplicated.
        state.container = 'running';
        return { code: 0, stdout: '{}' };
      }
      if (args[0] === 'master' && args[1] === 'init') { state.masterInit = true; return { code: 0, stdout: '{}' }; }
      return { code: 0, stdout: '{}' };
    },
  };
  return { state, events, deps };
}

test('integration:up-reruns-repair-partial — a rerun after an interrupted image step installs the control plane, fetches through the deploy key and creates deploy.env 0600', async () => {
  const fx = await fixture();
  const { state, events, deps } = host(fx);

  const first = await runUp(request(), deps);
  assert.equal(first.ok, false, 'the first run is interrupted after the image step');
  assert.equal(state.image, true);
  assert.equal(state.container, 'stopped', 'it leaves a container behind');

  const second = await runUp(request(), deps);
  assert.equal(second.exitCode, 0, second.next);
  assert.equal(state.container, 'running', 'the control plane is installed and answers');
  assert.equal(state.applies, 2);

  // The remote fetches through the deploy key up created.
  assert.equal(git(fx.root, 'remote', 'get-url', 'origin'), 'git@github.com:owner/project.git');
  const sshCommand = git(fx.root, 'config', 'core.sshCommand');
  assert.ok(sshCommand.includes(fx.key) && /IdentitiesOnly=yes/.test(sshCommand), sshCommand);
  assert.equal(git(fx.root, 'rev-parse', 'refs/remotes/origin/main'), git(fx.bare, 'rev-parse', 'main'), 'a real git fetch ran through the key');

  // deploy.env, created absent, 0600.
  assert.equal((await stat(join(fx.install, 'deploy.env'))).mode & 0o777, 0o600);

  // One contained npm ci on main, in a worktree up removes after.
  assert.deepEqual(state.npmCi, [git(fx.bare, 'rev-parse', 'main')]);
  assert.equal(git(fx.root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);

  // Everything answers: the rerun leaves the control plane alone.
  const third = await runUp(request(), deps);
  assert.equal(third.exitCode, 0, third.next);
  assert.equal(state.applies, 2, 'a control plane that answers is not installed again');
  assert.ok(events.some(event => event.kind === 'step' && event.step === 'control-plane' && event.state === 'skipped'));

  // The server stops answering while up.json still records the step: the rerun repairs it.
  state.container = 'stopped';
  const fourth = await runUp(request(), deps);
  assert.equal(fourth.exitCode, 0, fourth.next);
  assert.equal(state.applies, 3, 'the real check, not the recorded step, decides');
  assert.equal(state.container, 'running');
});

test('integration:up-reruns-repair-partial — a fetch the deploy key cannot make and a failed npm ci each stop up with one plain line', async () => {
  const fx = await fixture();
  const { state, events, deps } = host(fx);
  state.interrupt = false;

  state.refuse = true;
  const refused = await runUp(request(), deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.next.split('\n').length, 1, refused.next);
  assert.match(refused.next, /git fetch/);
  assert.match(refused.next, /deploy key/);
  assert.ok(refused.next.includes(`${fx.key}.pub`), `the fix names the public key to register: ${refused.next}`);

  state.refuse = false; state.npmCiCode = 1;
  const failed = await runUp(request(), deps);
  assert.equal(failed.ok, false);
  assert.match(failed.next, /bwrap --ro-bind \/ \/ -- npm ci/, 'the recorded command is named');
  assert.match(failed.next, /No version is set for shim/);
  const event = events.findLast(entry => entry.kind === 'step-failed');
  assert.ok(event && event.kind === 'step-failed' && event.argv?.join(' ').includes('npm ci'), JSON.stringify(event));
});
