import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { containedInstall, npmCiArgs, npmCiEnvironment } from '../src/cli/test-isolation.js';
import { readOnlyMountWrapper } from '../src/master/confinement.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4115: confinement moves HOME to /tmp/home, where mise found no installed tools and
// downloaded or rebuilt them. The sandbox keeps the host's mise data directory, read-only.

/** An operator home whose mise data directory holds one installed node, and a session checkout. */
async function hostWithMise() {
  const base = await temporaryDirectory('sandbox-mise');
  const operatorHome = join(base, 'operator'), mise = join(operatorHome, '.local', 'share', 'mise');
  const node = join(mise, 'installs', 'node', '99.0.0', 'bin', 'node');
  mkdirSync(join(node, '..'), { recursive: true });
  writeFileSync(node, '#!/bin/sh\necho host-node\n');
  chmodSync(node, 0o755);
  const root = join(base, 'checkout'), session = join(root, '.graphyard', 'worktrees', 'GY-4115-1');
  mkdirSync(session, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  return { root, session, operatorHome, mise, node };
}

const setenv = (words: readonly string[], name: string) => {
  const at = words.findIndex((word, index) => word === '--setenv' && words[index + 1] === name);
  return at < 0 ? undefined : words[at + 2];
};

test('unit:sandbox-passes-mise-data-dir — a sandbox with HOME moved gets MISE_DATA_DIR at the host mise data, bound read-only', async () => {
  const { root, session, operatorHome, mise } = await hostWithMise();
  const environment = { HOME: operatorHome, XDG_DATA_HOME: undefined, MISE_DATA_DIR: undefined };
  const words = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session, environment });
  assert.equal(setenv(words, 'HOME'), '/tmp/home');
  assert.equal(setenv(words, 'MISE_DATA_DIR'), mise);
  assert.ok(words.some((word, index) => word === '--ro-bind' && words[index + 1] === mise && words[index + 2] === mise), 'the mise data directory is bound read-only');

  // The loop's own MISE_DATA_DIR wins over the default under HOME.
  const own = join(operatorHome, 'own-mise');
  mkdirSync(own);
  assert.equal(setenv(readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session, environment: { ...environment, MISE_DATA_DIR: own } }), 'MISE_DATA_DIR'), own);
  // Empty MISE_DATA_DIR / XDG_DATA_HOME fall back to HOME/.local/share/mise.
  assert.equal(setenv(readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session, environment: { ...environment, MISE_DATA_DIR: '', XDG_DATA_HOME: '' } }), 'MISE_DATA_DIR'), mise);
  // A host without a mise data directory passes none.
  assert.equal(setenv(readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session, environment: { ...environment, HOME: join(operatorHome, 'none') } }), 'MISE_DATA_DIR'), undefined);
});

test('integration:contained-install-resolves-mise-shims — npm ci under containedInstall with mise shims first on PATH runs the host node and npm, never the shim', async () => {
  const base = await temporaryDirectory('contained-mise');
  // A mise whose shims fail the way a real one does when HOME is emptied: no installs, so it would download.
  const real = dirname(process.execPath), mise = join(base, 'bin', 'mise'), shims = join(base, 'shims'), project = join(base, 'project'), home = join(base, 'home');
  for (const directory of [dirname(mise), shims, project, home]) mkdirSync(directory, { recursive: true });
  writeFileSync(mise, `#!/bin/sh\ncase "$(basename "$0")" in\n  mise) [ "$1" = which ] && printf '%s\\n' "${real}/$2" ;;\n  *) echo "mise: downloading node" >&2; exit 1 ;;\nesac\n`);
  chmodSync(mise, 0o755);
  for (const tool of ['node', 'npm']) symlinkSync(mise, join(shims, tool));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  writeFileSync(join(project, 'package-lock.json'), JSON.stringify({ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'p', version: '1.0.0' } } }));
  const env = { PATH: `${shims}:${process.env.PATH}`, HOME: home, npm_config_cache: join(base, 'npm') };
  const install = containedInstall(project, ['npm', ...npmCiArgs], env);
  const run = spawnSync(install.command, install.args, { cwd: project, encoding: 'utf8', env: npmCiEnvironment(env) });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /downloading/);
});
