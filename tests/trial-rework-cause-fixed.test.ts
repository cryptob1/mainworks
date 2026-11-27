import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperSigningKeyFile } from '../src/hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3949: of the three merge-trial reworks in the 6 hours to 2026-11-27T00:20Z, only GY-3945's reproduces on
// main: browser-tests/host-shim-compat.spec.ts failed on `Command failed: ssh-keygen -q -t ed25519 -N  -C
// mainworks-helper -f <fresh home>/.config/graphyard/machine/helper-signing-key`. A trial's home is fresh and the
// browser suite runs fullyParallel, so two workers each saw no key and ran ssh-keygen on the final path; the second
// found the first's key there, asked to overwrite it, read EOF and exited 1.

const root = fileURLToPath(new URL('..', import.meta.url));
/** A new process reads the signer from `config` with `bin` leading its PATH. */
function read(config: string, bin: string, landed: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const { helperSigner } = await import('./src/hosts.ts'); process.stdout.write(helperSigner());"],
      { cwd: root, env: { ...process.env, GRAPHYARD_CONFIG_HOME: config, SIGNING_KEY_LANDED: landed, PATH: `${bin}:${process.env.PATH}` } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => done({ status, stdout, stderr }));
  });
}

test('integration:trial-rework-cause-fixed — a helper signing key another process lands first is kept and read, not refused by ssh-keygen', { timeout: 60_000 }, async () => {
  const home = await temporaryDirectory('trial-rework-cause-fixed'), config = join(home, 'config'), bin = join(home, 'bin'), landed = join(home, 'landed');
  await mkdir(bin);
  // The trial's race made deterministic: between this process's look and its own ssh-keygen call, another worker's key lands.
  await writeFile(join(bin, 'ssh-keygen'), `#!/bin/sh
key="$GRAPHYARD_CONFIG_HOME/machine/helper-signing-key"
[ -e "$key" ] || { mkdir -p "$(dirname "$key")"; /usr/bin/ssh-keygen -q -t ed25519 -N '' -C other-worker -f "$key" && cp "$key" "$SIGNING_KEY_LANDED"; }
exec /usr/bin/ssh-keygen "$@" </dev/null
`, { mode: 0o755 });
  const first = await read(config, bin, landed);
  assert.equal(first.status, 0, first.stderr);
  const landedPublic = execFileSync('ssh-keygen', ['-y', '-f', landed], { encoding: 'utf8' }).trim().split(/\s+/).slice(0, 2).join(' ');
  assert.equal(first.stdout, landedPublic, 'the caller signs with the key that landed first');
  assert.deepEqual(await readFile(helperSigningKeyFile(config)), await readFile(landed), 'that key is kept, not overwritten');
});
