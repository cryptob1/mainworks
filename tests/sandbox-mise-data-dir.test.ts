import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
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

/** PATH with real mise when installed (host and rebuilt trial image), or a stand-in inside the session for a pre-GY-4115 trial image. */
function pathWithMise(session: string): string {
  const base = process.env.PATH ?? '';
  if (spawnSync('sh', ['-c', 'command -v mise'], { env: { PATH: base } }).status === 0) return base;
  const bin = join(session, '.mise-bin'), script = join(bin, 'mise');
  mkdirSync(bin, { recursive: true });
  writeFileSync(script, '#!/bin/sh\nset -eu\n[ "$1" = which ] && [ "$2" = node ] || exit 2\ndata="${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}"\nbin="$data/installs/node/${MISE_NODE_VERSION:?}/bin/node"\n[ -x "$bin" ] || { echo "mise ERROR node@${MISE_NODE_VERSION} not installed in $data" >&2; exit 1; }\nprintf \'%s\\n\' "$bin"\n');
  chmodSync(script, 0o755);
  return `${bin}:${base}`;
}

test('integration:sandbox-mise-resolves-host-tools — `mise which node` inside a sandbox with HOME at /tmp/home names the host install', async () => {
  const { root, session, operatorHome, node } = await hostWithMise();
  const environment = { HOME: operatorHome, XDG_DATA_HOME: undefined, MISE_DATA_DIR: undefined };
  const [bwrap, ...words] = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: session, environment });
  const output = execFileSync(bwrap!, [...words, 'sh', '-c', 'echo "$HOME"; mise which node'], {
    cwd: session, encoding: 'utf8', env: { PATH: pathWithMise(session), HOME: operatorHome, MISE_NO_CONFIG: '1', MISE_OFFLINE: '1', MISE_NODE_VERSION: '99.0.0' } });
  assert.deepEqual(output.trim().split('\n'), ['/tmp/home', node]);
});
