import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from './temp-dirs.js';

// GY-3903: the one way a test makes a scratch Git repository. Commits made through `git` carry a
// fixed test identity, and a repository made by `gitRepo` has it in its config for any process the test starts.
const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** Run git in `cwd` under the test identity and return its trimmed stdout. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...identity } }).trim();

/**
 * A repository on `branch` (main) at `root`, or in a new temporary directory. With `files` it holds one
 * commit of them (`message`, default 'base'); with `origin` it pushes to a bare origin it tracks ('' without).
 */
export async function gitRepo(options: { root?: string; label?: string; branch?: string; files?: Record<string, string>; message?: string; origin?: boolean } = {}) {
  const { label = 'repo', branch = 'main', files, message = 'base' } = options;
  const root = options.root ?? await temporaryDirectory(label);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', branch);
  git(root, 'config', 'user.name', 't'); git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'commit.gpgsign', 'false');
  if (files) {
    for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); }
    git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', message);
  }
  let origin = '';
  if (options.origin) {
    origin = join(await temporaryDirectory(`${label}-origin`), 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', branch, origin);
    git(root, 'remote', 'add', 'origin', origin);
    if (files) git(root, 'push', '-q', '-u', 'origin', branch);
  }
  return { root, origin, head: files ? git(root, 'rev-parse', 'HEAD') : '', git: (...args: string[]) => git(root, ...args) };
}
