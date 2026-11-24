import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runRemoteSession } from '../src/remote-session.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3790: tests/remote-session-login.test.ts flaked in GY-3785's merge trial because
// runRemoteSession's mirror() ran `git read-tree -u --reset <work>` followed by `git reset -q`.
// Between those two commands the mirrored file was already written to disk with its expected
// content while still staged in `.git/index` (`A  work.txt`), so an observer polling the worktree
// (such as `mirrored()` in tests/remote-session-login.test.ts) saw `A  work.txt` instead of
// `?? work.txt`.

const gitIdentity = {
  GIT_AUTHOR_NAME: 'Worker',
  GIT_AUTHOR_EMAIL: 'worker@example.com',
  GIT_COMMITTER_NAME: 'Worker',
  GIT_COMMITTER_EMAIL: 'worker@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...gitIdentity } }).trim();

test('unit:remote-session-login-pinned — mirrored uncommitted work never appears staged in .git/index', async () => {
  const dir = await temporaryDirectory('remote-session-login-pinned');
  const origin = join(dir, 'origin');
  const worktree = join(dir, 'worktree');
  const remote = join(dir, 'remote');
  const account = join(dir, 'account');
  const bin = join(dir, 'bin');
  const cli = join(dir, 'cli', 'graphyard.mjs');
  await mkdir(origin, { recursive: true });
  await mkdir(account, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(join(account, 'auth.json'), JSON.stringify({ token: 'pinned-token' }), { mode: 0o600 });
  await writeFile(cli, 'console.log("ok");\n');

  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'user.name', 'Worker');
  git(origin, 'config', 'user.email', 'worker@example.com');
  await writeFile(join(origin, 'tracked.txt'), 'original\n');
  await writeFile(join(origin, 'removed.txt'), 'gone-soon\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'base');
  const base = git(origin, 'rev-parse', 'HEAD');

  git(origin, 'worktree', 'add', '-q', '-b', 'graphyard/gy-pinned-1', worktree, base);
  git(dir, 'clone', '-q', origin, remote);

  // Build a snapshot commit + bundle matching what sessionBoot emits for uncommitted work:
  // one new untracked file (work.txt), one modified tracked file (tracked.txt), and one deleted tracked file (removed.txt).
  await writeFile(join(remote, 'work.txt'), 'mirrored-uncommitted-work\n');
  await writeFile(join(remote, 'tracked.txt'), 'modified-on-host\n');
  git(remote, 'rm', '-q', 'removed.txt');
  git(remote, 'add', '-A');
  const tree = git(remote, 'write-tree');
  const work = git(remote, 'commit-tree', tree, '-p', base, '-m', 'uncommitted work');
  git(remote, 'update-ref', 'refs/graphyard/work', work);
  const bundlePath = join(dir, 'work.bundle');
  git(remote, 'bundle', 'create', bundlePath, 'refs/graphyard/work', `^${base}`);
  const bundle = (await readFile(bundlePath)).toString('base64');

  // Minimal stand-in ssh & docker so runRemoteSession runs its real mirror() on `worktree` without nested bwrap.
  const frame = `\u001emainworks-work ${JSON.stringify({ head: base, work, bundle })}\n\u001emainworks-login {}\n`;
  const framePath = join(dir, 'frames.txt');
  await writeFile(framePath, frame);
  await writeFile(join(bin, 'docker'), `#!/bin/sh
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  echo "sha256:${'5e55'.repeat(16)}"
  exit 0
fi
exit 0
`);
  await chmod(join(bin, 'docker'), 0o755);
  await writeFile(join(bin, 'ssh'), `#!/bin/sh
if [ "$1" = "-G" ]; then
  echo "hostname 127.0.0.1"
  echo "user gy-compute"
  exit 0
fi
for arg; do case "$arg" in -fNM|-O) exit 0;; esac; done
for last; do :; done
case "$last" in
  prepare-run\\ *) echo "run trial-pinned1" ;;
  run-session\\ *)
    IFS= read -r _req
    IFS= read -r _handover
    cat ${JSON.stringify(framePath)} >&2
    ;;
  clean\\ *) ;;
esac
exit 0
`);
  await chmod(join(bin, 'ssh'), 0o755);

  const observedDuringMirror: string[] = [];
  const wrappedRun: ChildRun = async (command, args, options) => {
    const result = await defaultChildRun(command, args, options);
    if (command === 'git' && args.includes('read-tree')) {
      // Exact check `mirrored()` in tests/remote-session-login.test.ts runs the moment `work.txt` appears on disk.
      observedDuringMirror.push(git(worktree, 'status', '--porcelain', '--', 'work.txt'));
    }
    return result;
  };

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const output: string[] = [];
  const sink = { write: (text: string) => { output.push(String(text)); return true; } } as unknown as NodeJS.WritableStream;
  try {
    const code = await runRemoteSession({
      target: 'gy-compute@pinnedhost',
      worktree,
      homes: [account],
      cli,
      argv: ['codex'],
      env: {},
      image: 'graphyard-trial:pinned',
      run: wrappedRun,
      output: sink,
      errors: sink,
    });
    assert.equal(code, 0, output.join(''));
  } finally {
    process.env.PATH = previousPath;
  }

  assert.deepEqual(
    observedDuringMirror,
    ['?? work.txt'],
    'the moment read-tree writes work.txt to the worktree, git status must report it untracked (?? work.txt), never staged (A  work.txt)',
  );
  assert.equal((await readFile(join(worktree, 'work.txt'), 'utf8')).trim(), 'mirrored-uncommitted-work');
  assert.equal((await readFile(join(worktree, 'tracked.txt'), 'utf8')).trim(), 'modified-on-host');
  assert.equal(
    execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' }).trimEnd(),
    [' D removed.txt', ' M tracked.txt', '?? work.txt'].join('\n'),
  );
});
