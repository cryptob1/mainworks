import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimScript, hostShimVerbs } from '../src/host-shim.js';
import { helperSigner, helperSigningKeyFile, readHostReadings } from '../src/hosts.js';
import { shardHosts, type ShardHostsFixture } from './helpers/shard-hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3896 AC-2: the copy a migration installs stores the coordinator's signer in the compute user's
// own state, so the next release's signed update applies through it with no person involved. A copy
// that finds no signer answers one plain line and exits non-zero. Shared keys stay refused.

const proof = 'integration:migrated-helper-takes-the-next-signed-update';
const target = 'gy-compute@box';
const oldDigest = '1'.repeat(64);

/** The pre-GY-3879 root-installed helper: exports MAINWORKS_SHIM only and takes unsigned updates (update-shim:1). */
const previousHelperScript = `#!/bin/sh
if [ -z "$MAINWORKS_SHIM" ]; then
  export MAINWORKS_SHIM="$HOME/.graphyard/shims/\${0##*/}-\${SSH_CLIENT%% *}"
  [ ! -f "$MAINWORKS_SHIM" ] || exec sh "$MAINWORKS_SHIM" "$@"
fi
case "$SSH_ORIGINAL_COMMAND" in
  probe)
    printf 'shim ${oldDigest}\\nverbs ${hostShimVerbs.map(verb => (verb === 'update-shim:2' ? 'update-shim:1' : verb)).join(' ')}\\nuser 1001 gy-compute\\ncompose 2.fixture\\ncores 8\\nload 0.25\\nruns 0\\n' ;;
  update-shim\\ *)
    exec python3 -I -c "
import hashlib, os, sys, tempfile
content, own = sys.stdin.buffer.read(1 << 20), os.environ['MAINWORKS_SHIM']
if hashlib.sha256(content).hexdigest() != os.environ['SSH_ORIGINAL_COMMAND'].split(' ')[1]: sys.exit('digest mismatch')
os.makedirs(os.path.dirname(own), exist_ok=True)
with tempfile.NamedTemporaryFile(dir=os.path.dirname(own), delete=False) as file: file.write(content)
os.replace(file.name, own)
" ;;
  *) exit 1 ;;
esac
`;

let hosts: ShardHostsFixture, config: string, hostsJson: string;
const saved = process.env.GRAPHYARD_CONFIG_HOME;
before(async () => {
  hosts = await shardHosts('migrated-helper-next-update', ['box'], {});
  config = await temporaryDirectory('migrated-helper-next-update-config');
  process.env.GRAPHYARD_CONFIG_HOME = config;
  hostsJson = join(hosts.root, 'hosts.json');
  await writeFile(hostsJson, JSON.stringify([{ target, addedAt: '2026-11-20T00:00:00.000Z', login: 'vish@box' }]));
});
after(() => { if (saved === undefined) delete process.env.GRAPHYARD_CONFIG_HOME; else process.env.GRAPHYARD_CONFIG_HOME = saved; });

const run: ChildRun = (command, args, options) =>
  defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
const shimsDir = () => join(hosts.home('box'), '.graphyard', 'shims');
const sign = (text: string) => execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', helperSigningKeyFile(config), '-n', 'mainworks-helper'], { input: text, encoding: 'utf8' });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const copy = async () => { const names = (await readdir(shimsDir())).filter(name => !name.endsWith('.signers')); assert.equal(names.length, 1, names.join(' ')); return join(shimsDir(), names[0]!); };
const runCopy = (path: string, verb: string, input: string, extra: string[] = []) =>
  spawnSync('sh', [path, ...extra], { input, encoding: 'utf8', env: { ...process.env, HOME: hosts.home('box'), MAINWORKS_SHIM: path, SSH_ORIGINAL_COMMAND: verb } });

test(`${proof} — a migrated copy stores the signer and the next release's signed update applies through it`, async () => {
  await rm(shimsDir(), { recursive: true, force: true });
  await writeFile(hosts.shim, previousHelperScript);

  const migrated = (await readHostReadings([], { file: hostsJson, run, local: 'here', update: true })).find(reading => reading.host === target)!;
  assert.equal(migrated.away, false, migrated.reason);
  assert.equal(migrated.updateError, undefined);
  const path = await copy();
  assert.equal((await readFile(`${path}.signers`, 'utf8')).trim(), `mainworks-helper namespaces="mainworks-helper" ${helperSigner(config)}`, 'the signer is stored in the compute user\'s state at migration');

  // The next release ships a copy that carries no signer of its own: the stored one is what verifies it.
  await writeFile(path, hostShimScript.replace(hostShimDigest, 'c'.repeat(64)));
  const next = (await readHostReadings([migrated], { file: hostsJson, run, local: 'here', update: true })).find(reading => reading.host === target)!;
  assert.equal(next.updateError, undefined, next.updateError);
  assert.equal(next.away, false);
  assert.equal(next.older, undefined, 'it runs this release\'s helper');

  // Shared keys remain refused.
  const shared = runCopy(path, `update-shim ${sha(hostShimScript)}`, sign(hostShimScript) + hostShimScript, ['--home', join(hosts.home('box'), 'shared')]);
  assert.equal(shared.status, 1);
  assert.equal(shared.stderr, `graphyard-host-shim refuses: update-shim ${sha(hostShimScript)}\n`);
});

test(`${proof} — a copy with no signer refuses the update in one plain line`, async () => {
  await rm(shimsDir(), { recursive: true, force: true });
  await mkdir(shimsDir(), { recursive: true });
  const path = join(shimsDir(), 'graphyard-host-shim-127.0.0.1');
  await writeFile(path, hostShimScript);
  const refused = runCopy(path, `update-shim ${sha(hostShimScript)}`, sign(hostShimScript) + hostShimScript);
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stderr, 'this helper has no trusted signer: run mainworks host add USER@HOST once\n');
});
