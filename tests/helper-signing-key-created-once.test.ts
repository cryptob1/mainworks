import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperSigningKeyFile } from '../src/hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3945: the merge writer's trial failed in browser-tests/host-shim-compat.spec.ts on
// `Command failed: ssh-keygen -q -t ed25519 -N  -C mainworks-helper -f <the trial's fresh home>/.config/graphyard/machine/helper-signing-key`.
// A trial's home is fresh, so the browser suite's parallel workers each create the signing key on first use: for every
// worker after the first, ssh-keygen found the key already there, asked whether to overwrite it, read EOF and exited 1.

const root = fileURLToPath(new URL('..', import.meta.url));
const proof = 'unit:helper-signing-key-created-once';
/** A new process reads the signer from `config`; `path` leads its PATH. */
function read(config: string, path = '', extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "const { helperSigner } = await import('./src/hosts.ts'); process.stdout.write(helperSigner());"],
      { cwd: root, env: { ...process.env, ...extra, GRAPHYARD_CONFIG_HOME: config, PATH: `${path}:${process.env.PATH}`.replace(/^:/, '') } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => done({ status, stdout, stderr }));
  });
}
const publicHalf = (key: string) => execFileSync('ssh-keygen', ['-y', '-f', key], { encoding: 'utf8' }).trim().split(/\s+/).slice(0, 2).join(' ');

test(`${proof} — the key another process lands first is the one read and kept`, { timeout: 60_000 }, async () => {
  const home = await temporaryDirectory('signing-key-created-once'), config = join(home, 'config'), bin = join(home, 'bin'), landed = join(home, 'landed');
  await mkdir(bin);
  // ssh-keygen as the trial had it: between this process's look and its own call, another process's key lands.
  await writeFile(join(bin, 'ssh-keygen'), `#!/bin/sh
key="$GRAPHYARD_CONFIG_HOME/machine/helper-signing-key"
[ -e "$key" ] || { mkdir -p "$(dirname "$key")"; /usr/bin/ssh-keygen -q -t ed25519 -N '' -C other-process -f "$key" && cp "$key" "$SIGNING_KEY_LANDED"; }
exec /usr/bin/ssh-keygen "$@"
`, { mode: 0o755 });
  const key = helperSigningKeyFile(config);
  const first = await read(config, bin, { SIGNING_KEY_LANDED: landed });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, publicHalf(landed), 'the caller reads the public half of the key that landed first');
  assert.deepEqual(await readFile(key), await readFile(landed), 'that key is kept, not overwritten');
  const later = await read(config, bin, { SIGNING_KEY_LANDED: landed });
  assert.equal(later.status, 0, later.stderr);
  assert.equal(later.stdout, first.stdout, 'a later process reads the same key');
  assert.deepEqual((await readdir(join(key, '..'), { withFileTypes: true })).filter(entry => entry.isDirectory()), [], 'no half-made pair is left beside it');
});

test(`${proof} — eight processes creating the key together read one key`, { timeout: 60_000 }, async () => {
  const config = join(await temporaryDirectory('signing-key-created-together'), 'config');
  const readers = await Promise.all(Array.from({ length: 8 }, () => read(config)));
  for (const reader of readers) assert.equal(reader.status, 0, reader.stderr);
  assert.equal(new Set(readers.map(reader => reader.stdout)).size, 1, 'every process read the same public half');
  assert.equal(readers[0]!.stdout, publicHalf(helperSigningKeyFile(config)), 'the public half of the key kept');
});
