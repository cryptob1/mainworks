import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostShimScript } from '../src/host-shim.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3879 AC-2: a second run-session for a run whose session container is live fails to create its own
// and leaves that container running: the helper starts its guardian only after its own create succeeds.

const proof = 'integration:retried-session-keeps-the-live-container';

test(`${proof} — a retried run-session for a live container leaves it running`, async () => {
  const root = await temporaryDirectory('retried-session'), home = join(root, 'home'), bin = join(root, 'bin'), containers = join(root, 'containers');
  const run = 'trial-abc123';
  await Promise.all([mkdir(join(home, '.graphyard', 'runs', run, 'repo'), { recursive: true }), mkdir(bin), mkdir(containers)]);
  await writeFile(join(home, '.graphyard', 'runs', run, 'image'), 'mainworks-session:1\n');
  // A Docker CLI whose containers are files: create refuses a name in use, as Docker does.
  await writeFile(join(bin, 'docker'), `#!/bin/sh
C='${containers}'
case "$1" in
  info) echo '[]' ;;
  create) for a; do [ "$prev" = --name ] && name="$a"; prev="$a"; done
    [ ! -e "$C/$name" ] || { echo "Conflict. The container name /$name is already in use" >&2; exit 1; }; : > "$C/$name" ;;
  start) for name; do :; done; cat >/dev/null ;;
  rm) for name; do :; done; rm -f "$C/$name" ;;
esac
`);
  await chmod(join(bin, 'docker'), 0o755);
  const live = join(containers, 'mainworks-session-abc123');
  await writeFile(live, '');
  const shim = join(root, 'graphyard-host-shim');
  await writeFile(shim, hostShimScript);
  const retried = spawnSync('sh', [shim], { input: `${JSON.stringify({ argv: ['codex'], env: {}, cwd: '/work', homes: [] })}\n`, encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SSH_ORIGINAL_COMMAND: `run-session ${run}` } });
  assert.equal(retried.status, 1);
  assert.match(retried.stderr, /the session container could not be created/);
  // A guardian, had one started, removes the container as soon as the helper exits.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(existsSync(live), 'the live session container is still there');
});
