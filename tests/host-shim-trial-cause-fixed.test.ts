import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3959: the two host-shim failures in merge trials in the 6 hours to 2026-11-27T02:20Z.
// - GY-3945 at d2656e53 (base 71c87927): browser-tests/host-shim-compat.spec.ts. Its two parallel workers each built the
//   host-shim fixture in the trial's fresh home; both ran ssh-keygen on the final helper signing key path and the second
//   exited 1 on the overwrite prompt. That reproduced on main until GY-3949. a22f2d9a has the fix; this case keeps it.
// - GY-3952 at 8984c278: tests/host-shim-runs-only-its-own-compose-project.test.ts /^db at db:5432$/. The candidate made
//   the fixture's Docker refuse an image the host lacks, and the test's run directory named an image never loaded.
//   Only that candidate fails this way. Its 02f642fd seeds the image; it passes on a22f2d9a and on GY-3952's merge.

const root = fileURLToPath(new URL('..', import.meta.url));

test('integration:host-shim-trial-cause-fixed — a host-shim fixture built while another worker lands the helper signing key keeps that key', { timeout: 60_000 }, async () => {
  const home = await temporaryDirectory('host-shim-trial-cause-fixed'), config = join(home, 'config'), bin = join(home, 'bin'), landed = join(home, 'landed');
  await mkdir(bin);
  // The trial's interleaving made certain: just before this worker's ssh-keygen creates the key, the other worker's lands.
  await writeFile(join(bin, 'ssh-keygen'), `#!/bin/sh
key="$GRAPHYARD_CONFIG_HOME/machine/helper-signing-key"
case " $* " in *" -t "*) [ -e "$key" ] || { mkdir -p "$(dirname "$key")"; /usr/bin/ssh-keygen -q -t ed25519 -N '' -C other-worker -f "$key" && cp "$key" "$SIGNING_KEY_LANDED"; } ;; esac
exec /usr/bin/ssh-keygen "$@" </dev/null
`, { mode: 0o755 });
  const built = await new Promise<{ status: number | null; stderr: string }>(done => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "const { shardHosts } = await import('./tests/helpers/shard-hosts.ts'); const { copyFileSync } = await import('node:fs'); copyFileSync((await shardHosts('host-shim-trial-cause', ['box'])).root + '/mainworks-helper-signers', process.env.SIGNERS);"],
      { cwd: root, env: { ...process.env, GRAPHYARD_CONFIG_HOME: config, SIGNERS: join(home, 'signers'), SIGNING_KEY_LANDED: landed, PATH: `${bin}:${process.env.PATH}` } });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => done({ status, stderr }));
  });
  assert.equal(built.status, 0, built.stderr);
  const landedPublic = execFileSync('ssh-keygen', ['-y', '-f', landed], { encoding: 'utf8' }).trim().split(/\s+/).slice(0, 2).join(' ');
  assert.equal(await readFile(join(home, 'signers'), 'utf8'), `mainworks-helper namespaces="mainworks-helper" ${landedPublic}\n`,
    'the fixture\'s host trusts the key the other worker landed');
});
