import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { hostPrepareScript } from '../src/hosts.js';

// GY-3697 AC-1: on a host where docker is in /usr/bin and dockerd-rootless-setuptool.sh in
// /usr/local/bin, the setup tool (like the real one) finds no docker beside it and fails. The printed
// script makes it find docker, enables the user unit explicitly and checks it is enabled and active.

const proof = 'unit:host-prepare-handles-split-docker-paths';
const executable = async (path: string, text: string) => { await writeFile(path, text); await chmod(path, 0o755); };

/** The printed script's Docker section, run against a fake root: docker in usr/bin, the setup tool in usr/local/bin. */
async function runDockerSection(label: string, enabledAnswer = 'enabled') {
  const root = await temporaryDirectory(label);
  const usrBin = join(root, 'usr', 'bin'), localBin = join(root, 'usr', 'local', 'bin'), standins = join(root, 'standins'), home = join(root, 'home', 'gy-compute');
  await Promise.all([usrBin, localBin, standins, home].map(dir => mkdir(dir, { recursive: true })));
  const log = join(root, 'log');
  await executable(join(usrBin, 'docker'), '#!/bin/sh\ncase "$1" in --version) echo "Docker version 29.10.0" ;; esac\n');
  // As the real tool: it runs $BIN/docker, BIN being its own directory.
  await executable(join(localBin, 'dockerd-rootless-setuptool.sh'), `#!/bin/sh
[ -x "$(dirname "$0")/docker" ] || { echo "[ERROR] Missing docker in $(dirname "$0")" >&2; exit 1; }
echo "setuptool $*" >> '${log}'
`);
  await executable(join(localBin, 'slirp4netns'), '#!/bin/sh\nexit 0\n');
  await executable(join(standins, 'sudo'), `#!/bin/sh
[ "$1" = -u ] && shift 2
while :; do case "$1" in *=*) export "$1"; shift ;; *) break ;; esac; done
exec "$@"
`);
  await executable(join(standins, 'install'), '#!/bin/sh\nfor last; do :; done\nmkdir -p "$last"\n');
  await executable(join(standins, 'chown'), '#!/bin/sh\nexit 0\n');
  await executable(join(standins, 'sleep'), '#!/bin/sh\nexit 0\n');
  await executable(join(standins, 'systemctl'), `#!/bin/sh
echo "systemctl $*" >> '${log}'
case "$*" in *is-enabled*) echo ${enabledAnswer}; [ ${enabledAnswer} = enabled ] ;; *is-active*) echo active ;; esac
`);
  const script = hostPrepareScript('ssh-ed25519 AAAA test');
  const start = script.indexOf('# Rootless Docker for $user'), end = script.indexOf('# A check that declares Compose services');
  assert.ok(start > 0 && end > start, 'the printed script has its Docker section');
  const section = `set -eu\nuser=gy-compute\nhome='${home}'\nuid=1001\n${script.slice(start, end)}`;
  const file = join(root, 'docker-section.sh');
  await writeFile(file, section);
  const result = spawnSync('sh', [file], { encoding: 'utf8', env: { ...process.env, PATH: `${standins}:${localBin}:${usrBin}:/usr/bin:/bin` } });
  return { result, log: await readFile(log, 'utf8').catch(() => '') };
}

test(`${proof} — the Docker section completes with docker in /usr/bin and the setup tool in /usr/local/bin, and enables the user unit`, async () => {
  const { result, log } = await runDockerSection('split-docker');
  assert.equal(result.status, 0, result.stderr);
  assert.match(log, /^setuptool install$/m, 'the setup tool ran its install');
  assert.match(log, /^systemctl --user enable docker\.service$/m, 'the user unit is enabled explicitly');
  assert.match(log, /^systemctl --user is-enabled docker\.service$/m, 'and checked');
  assert.match(result.stdout, /Docker for gy-compute: running and starts at boot/);
});

test(`${proof} — when the unit does not report enabled, the script says so and exits non-zero`, async () => {
  const { result } = await runDockerSection('split-docker-disabled', 'disabled');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Docker for gy-compute does not start at boot: docker\.service is disabled/);
});
