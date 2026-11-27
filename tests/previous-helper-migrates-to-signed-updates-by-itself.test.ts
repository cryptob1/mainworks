import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { hostShimDigest, hostShimScript, hostShimVerbs } from '../src/host-shim.js';
import { helperSigningKeyFile, readHostReadings } from '../src/hosts.js';
import { outdatedShimAttention } from '../src/merge-writer/remote-shards.js';
import { encodeLoopHosts, loopHosts } from '../src/model/loop-presence.js';
import { shardHosts, type ShardHostsFixture } from './helpers/shard-hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3891 AC-1: A host whose probe lists update-shim:1 without update-shim:2 is updated by the
// coordinator's loop through update-shim:1 with no person involved; afterwards its probe lists
// update-shim:2, the installed copy refuses update-shim:1 from any key and refuses update-shim,
// share and unshare from a shared key, and later releases update it through the signed form.
// The 'run mainworks host add' line appears only for a host that offers neither form, or whose
// update failed, with the reason (GY-3896: the host stays ready). Because the root-installed file on such a host is still
// the previous one, status carries one low-priority line per migrated host, 'updated without sudo;
// run mainworks host add USER@HOST when convenient to replace the installed helper', and never
// blocks work on it.

const proof = 'integration:previous-helper-migrates-to-signed-updates-by-itself';
const keyA = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK8q6YQk2xPpQ0n3Wl1m8VbR0bNfH2s7x9uJtLqXw5aZ owner';
const keyC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBm0e7y1Qw3cV2n8Zk4Lr6Tp9Xs5Hd1Fg7Jk3Mn2Pq8R install-c';
const target = 'gy-compute@box';
const oldDigest = '1'.repeat(64);

/** The pre-GY-3879 helper script: exports MAINWORKS_SHIM (no MAINWORKS_SIGNERS), advertises update-shim:1, accepts unsigned updates by digest. */
const previousHelperScript = `#!/bin/sh
refuse() { echo "graphyard-host-shim refuses: $SSH_ORIGINAL_COMMAND" >&2; exit 1; }
[ $# -eq 0 ] || { [ $# -eq 2 ] && [ "$1" = --home ]; } || refuse
if [ -z "$MAINWORKS_SHIM" ]; then
  export MAINWORKS_SHIM="\${2:-$HOME}/.graphyard/shims/\${0##*/}-\${SSH_CLIENT%% *}"
  [ ! -f "$MAINWORKS_SHIM" ] || exec sh "$MAINWORKS_SHIM" "$@"
fi
case "$SSH_ORIGINAL_COMMAND" in
  probe)
    echo "shim ${oldDigest}"
    echo "verbs ${hostShimVerbs.map(verb => (verb === 'update-shim:2' ? 'update-shim:1' : verb)).join(' ')}"
    echo "user 1001 gy-compute"
    echo "compose 2.fixture"
    echo "cores 8"
    echo "load 0.25"
    echo "cpu 100 0 100 800 0 0 0 0 0 0"
    echo "runs 0"
    ;;
  update-shim\\ *)
    exec python3 -I -c "$(cat <<'GRAPHYARD_VERBS'
import hashlib, os, re, sys, tempfile
asked = os.environ.get('SSH_ORIGINAL_COMMAND', '')
words = asked.split(' ')
if len(words) != 2 or not re.fullmatch(r'[0-9a-f]{64}', words[1]):
    sys.stderr.write('graphyard-host-shim refuses: ' + asked + '\\n')
    sys.exit(1)
content = sys.stdin.buffer.read(1 << 20)
own = os.environ['MAINWORKS_SHIM']
if hashlib.sha256(content).hexdigest() != words[1]:
    sys.exit('graphyard-host-shim refuses the update: its content does not match ' + words[1])
os.makedirs(os.path.dirname(own), exist_ok=True)
with tempfile.NamedTemporaryFile(dir=os.path.dirname(own), delete=False) as file:
    file.write(content)
os.replace(file.name, own)
GRAPHYARD_VERBS
)" "$@" ;;
  *) refuse ;;
esac
`;

/** A helper that offers neither update-shim:1 nor update-shim:2 (pre-GY-3780). */
const neitherFormHelperScript = previousHelperScript
  .replace(`shim ${oldDigest}`, `shim ${'2'.repeat(64)}`)
  .replace(' update-shim:1', '');

let hosts: ShardHostsFixture, config: string, hostsJson: string;
const savedConfig = process.env.GRAPHYARD_CONFIG_HOME;

before(async () => {
  hosts = await shardHosts('previous-helper-migrates', ['box'], {});
  config = await temporaryDirectory('previous-helper-migrates-config');
  process.env.GRAPHYARD_CONFIG_HOME = config;
  hostsJson = join(hosts.root, 'hosts.json');
  await writeFile(hostsJson, JSON.stringify([{ target, addedAt: '2026-11-20T00:00:00.000Z', login: 'vish@box' }]));
  await mkdir(join(hosts.home('box'), '.ssh'), { recursive: true });
  await writeFile(join(hosts.home('box'), '.ssh', 'authorized_keys'), `restrict,command="graphyard-host-shim" ${keyA}\n`);
});

after(() => {
  if (savedConfig === undefined) delete process.env.GRAPHYARD_CONFIG_HOME;
  else process.env.GRAPHYARD_CONFIG_HOME = savedConfig;
});

const run: ChildRun = (command, args, options) =>
  defaultChildRun(command, args, { ...options, env: { ...process.env, ...options?.env, PATH: `${hosts.bin}:${process.env.PATH}` } });
const call = (verb: string, input: string | Buffer = '', extraEnv: Record<string, string> = {}) =>
  spawnSync(join(hosts.bin, 'ssh'), [target, verb], { input, encoding: 'utf8', env: { ...process.env, PATH: `${hosts.bin}:${process.env.PATH}`, ...extraEnv } });
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const sign = (text: string, key = helperSigningKeyFile(config)) =>
  execFileSync('ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', 'mainworks-helper'], { input: text, encoding: 'utf8' });
const shimsDir = () => join(hosts.home('box'), '.graphyard', 'shims');

test(`${proof} — loop migrates an update-shim:1 host without sudo, migrated copy refuses v1 and shared-key updates, later releases update via signed v2, and status shows the low-priority migrated line`, async () => {
  await rm(shimsDir(), { recursive: true, force: true });
  await writeFile(hosts.shim, previousHelperScript);

  // Before loop update: host advertises update-shim:1 without update-shim:2.
  const beforeProbe = call('probe');
  assert.equal(beforeProbe.status, 0, beforeProbe.stderr);
  assert.match(beforeProbe.stdout, /\bupdate-shim:1\b/);
  assert.doesNotMatch(beforeProbe.stdout, /\bupdate-shim:2\b/);

  // 1. Coordinator loop updates it through update-shim:1 with no person involved.
  const readings = await readHostReadings([], { file: hostsJson, run, local: 'here', update: true });
  const reading = readings.find(entry => entry.host === target)!;
  assert.equal(reading.away, false, `migrated host must stay ready: ${reading.reason}`);
  assert.equal(reading.older, undefined, 'migrated host is no longer older');
  assert.equal(reading.migrated, true, 'migrated host is marked migrated without sudo');

  // Probe now lists update-shim:2 (and not update-shim:1) and this release's digest.
  const afterProbe = call('probe');
  assert.equal(afterProbe.status, 0, afterProbe.stderr);
  assert.match(afterProbe.stdout, new RegExp(`^shim ${hostShimDigest}$`, 'm'));
  assert.match(afterProbe.stdout, /\bupdate-shim:2\b/);
  assert.doesNotMatch(afterProbe.stdout, /\bupdate-shim:1\b/);

  // Status carries the exact low-priority line and never blocks work on the host.
  const crossed = loopHosts(encodeLoopHosts(readings))!;
  const migratedHost = crossed.find(entry => entry.host === target)!;
  assert.equal(migratedHost.away, false);
  assert.equal(migratedHost.migrated, true);
  const [migratedLine] = outdatedShimAttention([reading]);
  assert.ok(migratedLine, 'migrated host carries one low-priority status line');
  assert.ok(
    migratedLine.text.includes('updated without sudo; run mainworks host add vish@box when convenient to replace the installed helper'),
    `expected migrated wording, got: ${migratedLine.text}`,
  );

  // 2. The installed migrated copy refuses update-shim:1 (unsigned) from the primary key and unknown signers.
  const forged = '#!/bin/sh\necho owned\n';
  const otherKey = join(await temporaryDirectory('migrated-other-key'), 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', otherKey]);
  for (const input of [forged, sign(forged, otherKey) + forged, sign(hostShimScript) + forged]) {
    const refused = call(`update-shim ${sha(forged)}`, input);
    assert.equal(refused.status, 1, 'migrated copy must refuse unsigned or wrongly-signed updates');
    assert.match(refused.stderr, /^graphyard-host-shim refuses the update: /);
  }

  // 3. The migrated copy refuses update-shim, share and unshare from a shared key (--home).
  const [copiedName] = await readdir(shimsDir());
  assert.ok(copiedName, 'migrated copy exists in ~/.graphyard/shims');
  const copiedPath = join(shimsDir(), copiedName!);
  const sharedState = join(hosts.home('box'), '.graphyard', 'installs', 'shared-test');
  await mkdir(sharedState, { recursive: true });
  for (const [verb, input] of [
    [`update-shim ${sha(forged)}`, forged],
    [`update-shim ${sha(hostShimScript)}`, sign(hostShimScript) + hostShimScript],
    ['share', `${keyC}\n`],
    ['unshare', `${keyA}\n`],
  ] as const) {
    const refused = spawnSync('sh', [copiedPath, '--home', sharedState], {
      input,
      encoding: 'utf8',
      env: { ...process.env, HOME: hosts.home('box'), MAINWORKS_SHIM: copiedPath, SSH_ORIGINAL_COMMAND: verb },
    });
    assert.equal(refused.status, 1, `shared key must be refused ${verb}`);
    assert.equal(refused.stderr, `graphyard-host-shim refuses: ${verb}\n`, verb);
  }

  // 4. Later releases update the migrated copy through the signed form (update-shim:2), still without sudo.
  const copyBefore = await readFile(copiedPath, 'utf8');
  await writeFile(copiedPath, copyBefore.replace(hostShimDigest, 'c'.repeat(64)).replace(' receive-image:4', ''));
  const laterReadings = await readHostReadings(readings, { file: hostsJson, run, local: 'here', update: true });
  const later = laterReadings.find(entry => entry.host === target)!;
  assert.equal(later.away, false, `later signed update should succeed: ${later.reason}`);
  assert.equal(later.older, undefined);
  assert.equal(later.migrated, true, 'root-installed file is still the previous one');
  assert.match(call('probe').stdout, new RegExp(`^shim ${hostShimDigest}$`, 'm'));
});

test(`${proof} — host with neither form shows the 'run mainworks host add' instruction; a failed update keeps the host ready and shows the reason`, async () => {
  // Host offering neither update-shim:1 nor update-shim:2 shows the host add instruction.
  await rm(shimsDir(), { recursive: true, force: true });
  await writeFile(hosts.shim, neitherFormHelperScript);
  const neither = (await readHostReadings([], { file: hostsJson, run, local: 'here', update: true })).find(entry => entry.host === target)!;
  assert.equal(neither.away, false, 'still has trial verbs so stays ready');
  assert.equal(neither.older, true);
  const [neitherLine] = outdatedShimAttention([neither]);
  assert.ok(neitherLine, 'host with neither form shows host add instruction');
  assert.match(neitherLine.text, /run mainworks host add vish@box in a terminal/);

  // GY-3896: a failed update keeps the host ready, is tried once a cycle at most, and shows the reason in one line.
  await rm(shimsDir(), { recursive: true, force: true });
  await writeFile(hosts.shim, previousHelperScript.replace('os.replace(file.name, own)', "sys.exit('Disk quota exceeded')"));
  let failCalls = 0;
  const failingRun: ChildRun = async (command, args, options) => {
    if (command === 'sh' && typeof args[1] === 'string' && args[1].includes('update-shim ')) failCalls++;
    return run(command, args, options);
  };
  const failed = (await readHostReadings([], { file: hostsJson, run: failingRun, local: 'here', update: true })).find(entry => entry.host === target)!;
  assert.equal(failCalls, 1, 'one attempt, retried at most hourly');
  assert.equal(failed.away, false);
  assert.equal(failed.updateError, 'Disk quota exceeded');
  const [failedLine] = outdatedShimAttention([failed]);
  assert.ok(failedLine);
  assert.match(failedLine.text, /Disk quota exceeded/);
  assert.match(failedLine.next, /Run mainworks host add vish@box in a terminal/);
});
