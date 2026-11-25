// Concern: GY-3407 — the hosts Mainworks watches; merge trials send them test shards (GY-3412). A host lends
// compute and nothing else: a one-time sudo script (`host prepare` prints it; `host add` runs it) creates the
// unprivileged gy-compute user (not in the docker group) with linger and rootless Docker, and lets this
// machine's key run only graphyard-host-shim-DIGEST (restrict,command=…: no shell, pty or forwarding). The shim
// answers fixed verbs (src/host-shim.ts). `mainworks host add USER@HOST` refuses a key
// that opens a plain shell, root and a docker-group user, then records the host in this machine's hosts
// file — the one host list. Each loop cycle probes every host — cores, hottest CPU sensor, steal and the
// trial containers running now — this machine first; a host that does not answer reads away.
// GY-3440: where port 22 is Tailscale SSH (it ignores authorized_keys and so the shim), prepare adds a
// second OpenSSH for gy-compute only on port 2222; host add takes USER@HOST:PORT or an ssh-config alias
// and reports whether the operator's own account logs into that host unattended on port 22.
// GY-3834: `host add OWNER@HOST` in a terminal runs that script over its own SSH session with sudo, then
// records gy-compute@HOST; `host share` lets an enrolled coordinator bind another install's key to the
// same helper (the shim's share verb), so a second install needs no root there.
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { defaultChildRun, type ChildRun } from './child-runner.js';
import { configHome } from './install/secrets.js';
import { cpuSensorNames } from './merge-writer/trial-load.js';
import { cpuStatTotals, stealPercent } from './daemon/cpu-pressure.js';
import { hostProbeScript, hostShimDigest, hostShimScript, missingTrialVerbs, trialVerbs } from './host-shim.js';
import { trialAppArmorProfilePath, trialAppArmorProfileText } from './merge-writer/trial-apparmor.js';
import { shellQuote } from './install/transport.js';

/** `sessions` (GY-3405): how many agent sessions the host takes at once; absent or 0, it takes test shards only. */
export interface HostRecord { target: string; addedAt: string; sessions?: number }
/** GY-3517: `at` is when this probe read the host; `update` marks one away only because its shim lacks a trial verb. */
export interface HostReading { host: string; local?: boolean; at?: string; away: boolean; /** GY-3601: when an away host stopped answering. */ since?: string; update?: boolean; /** GY-3780: why it did not take this release's helper. */ updateError?: string; /** GY-3744: its helper's digest is not this release's. */ older?: boolean; reason?: string; cores: number | null; celsius: number | null; steal: number | null; runs: number | null; /** GY-3528: cores busy (the 1-minute load). */ busy?: number | null; stat?: { total: number; steal: number } | null }

/** Machine-wide, beside the machine-share link (team-access.ts): every install's loop on this machine reads the same hosts. */
export const hostsFile = (home = configHome()) => join(home, 'machine', 'hosts.json');
/** GY-3698: compute host keys live beside hosts.json in the machine folder, so a confined master with no ~/.ssh records and verifies them. */
export const hostKnownHostsFile = (home = configHome()) => join(home, 'machine', 'known_hosts');
/** SSH options that pin compute host keys to the machine folder with accept-new. */
const hostKeySshOptions = (knownHosts = hostKnownHostsFile()) => ['-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=accept-new'];
/** USER@HOST, USER@HOST:PORT, or an ssh-config alias. */
const hostTargetPattern = /^(?:[a-z_][a-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?|[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const computePort = 2222;
export const hostUser = 'gy-compute';

export async function readHosts(file = hostsFile()): Promise<HostRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '[]');
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is HostRecord => typeof entry?.target === 'string') : [];
}
const writeHosts = async (file: string, hosts: HostRecord[]) => { if (!existsSync(dirname(file))) await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(hosts, null, 2) + '\n'); };

/**
 * The one-time script `host prepare` prints, for the host's owner to run with sudo. GY-3688: one host
 * serves several installs, so the helper is named by its digest, this machine's key is appended beside
 * the others bound to that helper, and helpers no key names are removed.
 */
export function hostPrepareScript(publicKey: string, shim = { script: hostShimScript, digest: hostShimDigest }) {
  const helper = `graphyard-host-shim-${shim.digest}`;
  const [type, body] = publicKey.trim().split(/\s+/);
  return `#!/bin/sh
# Run once on the host with: sudo sh prepare.sh
# Creates ${hostUser}: no sudo, not in the docker group, its own rootless Docker. This machine's key
# may only run graphyard-host-shim as ${hostUser}: no shell, pty, port or agent forwarding.
set -eu
user=${hostUser}
target="$user@$(hostname)"
command -v python3 >/dev/null && command -v git >/dev/null || { echo "Install python3 and git, then run this again." >&2; exit 1; }
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/sh "$user"
gpasswd -d "$user" docker >/dev/null 2>&1 || true
grep -q "^$user:" /etc/subuid || usermod --add-subuids 300000-365535 --add-subgids 300000-365535 "$user"
loginctl enable-linger "$user"
# Shards start nested sandboxes; where the host enforces AppArmor, Docker runs them under this profile (GY-3549).
if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = Y ]; then
  printf %s ${shellQuote(trialAppArmorProfileText)} > ${trialAppArmorProfilePath} && apparmor_parser -r -W ${trialAppArmorProfilePath}
fi
cat > /usr/local/bin/${helper} <<'GRAPHYARD_SHIM'
${shim.script}GRAPHYARD_SHIM
chmod 755 /usr/local/bin/${helper}
home=$(getent passwd "$user" | cut -d: -f6)
install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
# This machine's key, bound to its own helper, beside other installs' keys: only its own older line is replaced.
keys="$home/.ssh/authorized_keys"
line=${shellQuote(`restrict,command="${helper}" ${publicKey.trim()}`)}
touch "$keys"
if ! grep -qxF "$line" "$keys"; then
  { grep -vF ${shellQuote(` ${type} ${body}`)} "$keys" || true; echo "$line"; } > "$keys.new"
  mv "$keys.new" "$keys"
fi
chown "$user:$user" "$keys"; chmod 600 "$keys"
# Helpers no key names are left from older releases: remove them.
for helper in /usr/local/bin/graphyard-host-shim*; do
  [ -e "$helper" ] || continue
  grep -qF "command=\\"\${helper##*/}\\"" "$keys" || rm -f "$helper"
done
# The helper just installed runs, not an update it took earlier.
rm -f "$home/.graphyard/shims/${helper}-"*
uid=$(id -u "$user")
# Rootless Docker for $user (GY-3419): the host's own extras when both tools are installed, else the
# static rootless extras for the host's reported Docker version plus a static slirp4netns fetched
# into $user's home — nothing is fetched when a copy is already there. The setup tool writes the
# daemon's unit with its own directory first on PATH, so the fetched rootlesskit and slirp4netns are
# the ones the daemon runs.
dir="$home/.graphyard/rootless/docker-rootless-extras"
if command -v dockerd-rootless-setuptool.sh >/dev/null && command -v slirp4netns >/dev/null; then
  setuptool=$(command -v dockerd-rootless-setuptool.sh)
elif [ -x "$dir/dockerd-rootless-setuptool.sh" ] && [ -x "$dir/slirp4netns" ]; then
  setuptool="$dir/dockerd-rootless-setuptool.sh"
else
  command -v curl >/dev/null || { echo "Install curl, then run this again." >&2; exit 1; }
  version=\$(docker --version 2>/dev/null | sed -n 's/^Docker version \\([0-9][0-9.]*\\).*/\\1/p')
  [ -n "$version" ] || { echo "docker --version answered no version: install Docker, then run this again." >&2; exit 1; }
  arch=\$(uname -m)
  case "$arch" in x86_64|aarch64) ;; *) echo "No static Docker rootless extras for $arch: install dockerd-rootless-setuptool.sh and slirp4netns, then run this again." >&2; exit 1 ;; esac
  slirp=v1.3.7
  mkdir -p "$dir"
  echo "Fetching Docker rootless extras $version and slirp4netns $slirp into gy-compute's home..."
  curl -fsSL --retry 3 -o "$home/.graphyard/rootless/extras-$version.tgz" "https://download.docker.com/linux/static/stable/$arch/docker-rootless-extras-$version.tgz"
  tar -xzf "$home/.graphyard/rootless/extras-$version.tgz" -C "$home/.graphyard/rootless"
  curl -fsSL --retry 3 -o "$dir/slirp4netns-$arch" "https://github.com/rootless-containers/slirp4netns/releases/download/$slirp/slirp4netns-$arch"
  curl -fsSL --retry 3 -o "$dir/SHA256SUMS" "https://github.com/rootless-containers/slirp4netns/releases/download/$slirp/SHA256SUMS"
  grep "slirp4netns-$arch\\$" "$dir/SHA256SUMS" | (cd "$dir" && sha256sum -c -) || { echo "The fetched slirp4netns did not verify." >&2; exit 1; }
  chmod 755 "$dir/slirp4netns-$arch"; ln -sfn "slirp4netns-$arch" "$dir/slirp4netns"
  for tool in dockerd-rootless-setuptool.sh dockerd-rootless.sh rootlesskit; do
    [ -x "$dir/$tool" ] || { echo "The fetched Docker rootless extras lack $tool." >&2; exit 1; }
  done
  "$dir/rootlesskit" --version >/dev/null && "$dir/slirp4netns" --version >/dev/null || { echo "The fetched rootless tools do not run on $arch." >&2; exit 1; }
  setuptool="$dir/dockerd-rootless-setuptool.sh"
fi
install -d "$home/.graphyard"
chown -R "$user:$user" "$home/.graphyard"
# The setup tool runs the docker beside it (GY-3697): where docker lives elsewhere, link it there.
tooldir=$(dirname "$setuptool")
if [ ! -x "$tooldir/docker" ]; then
  docker=$(command -v docker) || { echo "Install Docker, then run this again." >&2; exit 1; }
  ln -sfn "$docker" "$tooldir/docker"
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "/run/user/$uid/bus" ] && break; sleep 1; done
as_user() { sudo -u "$user" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" PATH="$tooldir:$PATH" "$@"; }
as_user "$setuptool" install
# Docker must come back after a reboot: enable the user unit and check it.
as_user systemctl --user enable docker.service || true
enabled=$(as_user systemctl --user is-enabled docker.service || true)
active=$(as_user systemctl --user is-active docker.service || true)
[ "$enabled" = enabled ] || { echo "Docker for $user does not start at boot: docker.service is \${enabled:-unknown}. See journalctl --user -u docker.service as $user, then run this again." >&2; exit 1; }
[ "$active" = active ] || { echo "Docker for $user is not running: docker.service is \${active:-unknown}. See journalctl --user -u docker.service as $user, then run this again." >&2; exit 1; }
echo "Docker for $user: running and starts at boot"
# A check that declares Compose services runs whole on this host, so its rootless Docker needs the Compose plugin.
if sudo -u "$user" docker compose version >/dev/null 2>&1; then echo "Docker Compose plugin: found. Checks that declare Compose services can run here."
else echo "Docker Compose plugin: missing. This host's rootless Docker needs it to run checks that declare Compose services; install docker-compose-plugin and they run here. Test shards work without it."; fi
# Tailscale SSH on port 22 ignores authorized_keys, so the shim: give $user its own OpenSSH on port ${computePort}.
if tailscale debug prefs 2>/dev/null | grep -q '"RunSSH": *true'; then
  sshd=$(command -v sshd) || { echo "Install the OpenSSH server (sshd), then run this again." >&2; exit 1; }
  ssh-keygen -A
  cat > /etc/ssh/sshd_graphyard_config <<GRAPHYARD_SSHD
Port ${computePort}
AllowUsers $user
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowTcpForwarding no
AllowAgentForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
PermitTTY no
PidFile /run/graphyard-sshd.pid
GRAPHYARD_SSHD
  "$sshd" -t -f /etc/ssh/sshd_graphyard_config
  cat > /etc/systemd/system/graphyard-sshd.service <<GRAPHYARD_UNIT
[Unit]
Description=OpenSSH for $user only (Mainworks compute, port ${computePort})
After=network.target
[Service]
ExecStart=$sshd -D -f /etc/ssh/sshd_graphyard_config
Restart=always
[Install]
WantedBy=multi-user.target
GRAPHYARD_UNIT
  systemctl daemon-reload
  systemctl enable --now graphyard-sshd
  # An older prepare's config forced one helper for every key: restart so this config is the one serving.
  systemctl restart graphyard-sshd
  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then ufw allow in on tailscale0 to any port ${computePort} proto tcp; fi
  target="$target:${computePort}"
  echo "Port 22 here is Tailscale SSH, which skips the shim. Tailnet check: in your tailnet policy, every ssh rule reaching this machine needs action check, never accept, so no account here logs in unattended. Mainworks reaches $user on port ${computePort}."
fi
echo "Ready. On the Mainworks machine run: mainworks host add $target"
`;
}

/** This machine's SSH public key, the one `host prepare` authorizes. */
export async function localPublicKey(home = homedir()) {
  for (const name of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
    const key = await readFile(join(home, '.ssh', name), 'utf8').catch(() => null);
    if (key?.trim()) return key.trim();
  }
  throw new Error(`No SSH public key in ${join(home, '.ssh')}: create one with ssh-keygen -t ed25519, then run that command again`);
}

function parseHostProbe(text: string) {
  if (/^(?:graphyard|mainworks)-no-docker$/m.test(text)) return null;
  const number = (pattern: RegExp) => { const value = Number(pattern.exec(text)?.[1]); return Number.isFinite(value) ? value : null; };
  const temps = [...text.matchAll(/^temp (\S+) (\d+)$/gm)].filter(match => cpuSensorNames.includes(match[1]!)).map(match => Math.floor(Number(match[2]) / 1000));
  const user = /^user (\d+) ?(.*)$/m.exec(text);
  const verbs = /^verbs (.*)$/m.exec(text)?.[1]?.split(' ').filter(Boolean) ?? null;
  return { shim: /^shim ([0-9a-f]{64})$/m.exec(text)?.[1] ?? null, verbs, compose: /^compose \S/m.test(text), cores: number(/^cores (\d+)$/m), load: number(/^load ([\d.]+)$/m), runs: number(/^runs\s+(\d+)$/m), celsius: temps.length ? Math.max(...temps) : null, stat: cpuStatTotals(text),
    uid: user ? Number(user[1]) : null, groups: user ? user[2]!.split(/\s+/).filter(Boolean) : [] };
}

const targetHost = (target: string) => target.replace(/^.*@/, '').replace(/:\d+$/, '');
/** GY-3834: the one command that prepares a host, for the owner to run in a terminal on this machine. */
export const hostAddCommand = (target: string) => `mainworks host add ${userInfo().username}@${targetHost(target)} in a terminal`;
const outdatedShimReason = (target: string, missing: readonly string[] = []) => `${target}'s graphyard-host-shim is older than this release: run ${hostAddCommand(target)}${missing.length ? ` (it lacks ${missing.join(', ')})` : ''}`;
const lastLine = (text: string) => text.trim().split('\n').filter(Boolean).at(-1) ?? '';
/** ssh's arguments for a host target: USER@HOST:PORT becomes -p PORT USER@HOST; USER@HOST and an alias pass as they are. */
export const sshTarget = (target: string) => { const port = /^(.+@.+):(\d+)$/.exec(target); return port ? ['-p', port[2]!, port[1]!] : [target]; };
const ensureKnownHostsDirectory = async (knownHosts: string) => { if (!existsSync(dirname(knownHosts))) await mkdir(dirname(knownHosts), { recursive: true }).catch(() => {}); };
const ssh = async (target: string, verb: string, run: ChildRun, knownHosts = hostKnownHostsFile()) => {
  await ensureKnownHostsDirectory(knownHosts);
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...hostKeySshOptions(knownHosts), ...sshTarget(target), verb], { timeoutMs: 15_000 });
};
const hostKeyChanged = (error: any) => /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`);
const sshFailure = (target: string, error: any, knownHosts: string) => hostKeyChanged(error)
  ? `${target}'s SSH host key changed: remove its old line from ${knownHosts} if you rebuilt the host`
  : `${target} is unreachable over SSH: ${lastLine(String(error?.stderr ?? '')) || (error?.timedOut ? 'no answer within 15 seconds' : String(error?.message ?? error))}`;

/** GY-3697: the probe's docker-unit line says whether rootless Docker's user unit failed or is not enabled. */
function noDockerReason(name: string, output: string) {
  const [, enabled, active] = /^docker-unit (\S*) ?(\S*)$/m.exec(output) ?? [];
  if (active === 'failed') return `${name} answers but its Docker failed (docker.service failed): see journalctl --user -u docker.service as ${hostUser} there, or run ${hostAddCommand(name)}`;
  if (enabled && enabled !== 'enabled') return `${name} answers but its Docker is not enabled (docker.service is ${enabled}), so it stops at reboot: run ${hostAddCommand(name)}`;
  return `${name} answers but its Docker does not: run ${hostAddCommand(name)}`;
}

/** One probe of a host through its shim (null: this machine): its readings, or the plain reason it cannot be read. */
export async function probeHost(target: string | null, run: ChildRun = defaultChildRun, knownHosts = hostKnownHostsFile()) {
  let output: string;
  try { output = String(await (target ? ssh(target, 'probe', run, knownHosts) : run('sh', ['-c', hostProbeScript], { timeoutMs: 15_000 }))); }
  catch (error: any) {
    if (!target) return { ok: false as const, reason: `this machine could not be read: ${lastLine(String(error?.stderr ?? '')) || String(error?.message ?? error)}` };
    return { ok: false as const, reason: error?.status === 255 || error?.timedOut ? sshFailure(target, error, knownHosts) : `${target} does not answer graphyard-host-shim's probe: run ${hostAddCommand(target)}` };
  }
  const reading = parseHostProbe(output);
  if (!reading) return { ok: false as const, reason: noDockerReason(target ?? 'this machine', output) };
  // GY-3476, GY-3517: a shim from an older release takes shards while it speaks every verb a trial uses; one lacking any waits for prepare.
  const missing = target ? missingTrialVerbs(reading) : [];
  if (missing.length) return { ok: false as const, update: true, reason: outdatedShimReason(target!, missing), shim: reading.shim, verbs: reading.verbs };
  return { ok: true as const, ...reading };
}

/** GY-3780: send this release's shim to a host on another one, over the same restricted key: null once the host took it, else why not. */
async function updateHostShim(target: string, run: ChildRun, knownHosts: string): Promise<string | null> {
  const words = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...hostKeySshOptions(knownHosts), ...sshTarget(target), `update-shim ${createHash('sha256').update(hostShimScript).digest('hex')}`];
  try { await run('sh', ['-c', `printf %s ${shellQuote(hostShimScript)} | ${words.map(shellQuote).join(' ')}`], { timeoutMs: 15_000 }); return null; }
  catch (error: any) { return lastLine(String(error?.stderr ?? '')) || (error?.timedOut ? 'no answer within 15 seconds' : `exit ${error?.status ?? 'signal'}`); }
}

/** A host's key must reach only the shim: a plain shell command run through it is refused. */
async function opensPlainShell(target: string, run: ChildRun, knownHosts: string) {
  try { return String(await ssh(target, 'echo mainworks-plain-shell', run, knownHosts)).includes('mainworks-plain-shell') ? 'yes' : 'no'; }
  catch (error: any) { return error?.status === 255 || error?.timedOut ? sshFailure(target, error, knownHosts) : 'no'; }
}

/** Read-only: does this machine's own account open a shell on the host's port 22 (Tailscale SSH or a key) with nobody there to approve it? */
async function operatorLogin(target: string, run: ChildRun = defaultChildRun, account = userInfo().username, knownHosts = hostKnownHostsFile()) {
  const host = /^hostname (\S+)$/m.exec(String(await Promise.resolve(run('ssh', ['-G', ...sshTarget(target)], { timeoutMs: 5_000 })).catch(() => '')))?.[1] ?? targetHost(target);
  const login = `${account}@${host}`;
  try {
    await ensureKnownHostsDirectory(knownHosts);
    await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...hostKeySshOptions(knownHosts), '-p', '22', login, 'true'], { timeoutMs: 15_000 });
    return { login, unattended: true };
  }
  catch { return { login, unattended: false }; }
}

/** The account a target logs in as: USER@…, else what ssh's config resolves an alias to. */
async function loginUser(target: string, run: ChildRun) {
  if (target.includes('@')) return target.split('@')[0]!;
  return /^user (\S+)$/m.exec(String(await Promise.resolve(run('ssh', ['-G', target], { timeoutMs: 5_000 })).catch(() => '')))?.[1] ?? hostUser;
}

/** GY-3834: run the prepare script on the host over one SSH session with sudo; its prompts and output reach this terminal. What it printed. */
async function prepareOverSsh(target: string, script: string, knownHosts: string) {
  await ensureKnownHostsDirectory(knownHosts);
  const child = spawn('ssh', ['-t', ...hostKeySshOptions(knownHosts), ...sshTarget(target), `sudo sh -c ${shellQuote(script)}`], { stdio: ['inherit', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk; process.stdout.write(chunk); });
  const code = await new Promise<number | null>(resolve => { child.on('close', resolve); child.on('error', () => resolve(null)); });
  if (code !== 0) throw new Error(`${target} was not prepared: the script stopped${code === null ? '' : ` (exit ${code})`}; its output is above`);
  return output;
}

/**
 * Record a host. GY-3834: given the owner's own login rather than gy-compute, find the host prepared (a no-op
 * when its helper already answers this machine's key), else prepare it over SSH — only from a terminal, where
 * sudo can ask — and record gy-compute@HOST.
 */
export async function addHost(target: string, options: { file?: string; knownHosts?: string; run?: ChildRun; terminal?: boolean; publicKey?: string } = {}) {
  const file = options.file ?? hostsFile(), run = options.run ?? defaultChildRun;
  const knownHosts = options.knownHosts ?? (options.file ? join(dirname(options.file), 'known_hosts') : hostKnownHostsFile());
  if (target.length > 300 || !hostTargetPattern.test(target)) throw new Error(`Name the host as USER@HOST, USER@HOST:PORT or an ssh-config alias, for example ${hostUser}@omarchypc:${computePort}: got ${JSON.stringify(target)}`);
  if (['root', hostUser].includes(await loginUser(target, run))) return recordHost(target, file, run, knownHosts);
  const host = targetHost(target), candidates = [`${hostUser}@${host}`, `${hostUser}@${host}:${computePort}`];
  const probes = await Promise.all(candidates.map(candidate => probeHost(candidate, run, knownHosts)));
  const prepared = candidates.find((_, index) => { const probe = probes[index]!; return probe.ok && probe.verbs?.includes('update-shim:1'); });
  if (prepared) return { ...(await recordHost(prepared, file, run, knownHosts, false)), target: prepared, prepared: true };
  if (!(options.terminal ?? (process.stdin.isTTY && process.stdout.isTTY))) throw new Error(`Run this in a terminal: mainworks host add ${target}`);
  const output = await prepareOverSsh(target, hostPrepareScript(options.publicKey ?? await localPublicKey()), knownHosts);
  const port = /host add \S+?:(\d+)\s*$/m.exec(output)?.[1];
  const compute = `${hostUser}@${host}${port ? `:${port}` : ''}`;
  return { ...(await recordHost(compute, file, run, knownHosts, false)), target: compute, prepared: false };
}

/** Check a gy-compute target answers only through the shim, as neither root nor the docker group, and record it. */
async function recordHost(target: string, file: string, run: ChildRun, knownHosts: string, checkOperator = true) {
  const hosts = await readHosts(file);
  if (hosts.some(host => host.target === target)) return { added: false, target, hosts };
  const refuse = (reason: string) => { throw new Error(`${target} was not added: ${reason}`); };
  const shell = await opensPlainShell(target, run, knownHosts);
  if (shell === 'yes') refuse(`its SSH key opens a plain shell, so Mainworks could reach everything that user can; run ${hostAddCommand(target)}`);
  if (shell !== 'no') refuse(shell);
  const probe = await probeHost(target, run, knownHosts);
  if (!probe.ok) refuse(probe.reason);
  if (probe.ok && probe.uid === 0) refuse(`it logs in as root; run ${hostAddCommand(target)}, which creates the unprivileged ${hostUser} user`);
  if (probe.ok && probe.groups.includes('docker')) refuse(`${target.split('@')[0]} is in the docker group, which is root on that host; run ${hostAddCommand(target)} for ${hostUser} with rootless Docker`);
  const next = [...hosts, { target, addedAt: new Date().toISOString() }];
  await writeHosts(file, next);
  return { added: true, target, hosts: next, probe: probe.ok ? probe : null, operator: checkOperator ? await operatorLogin(target, run, userInfo().username, knownHosts) : null };
}

/**
 * GY-3834: from an enrolled coordinator, bind another install's key on `target` to the same restricted helper
 * with its own state directory (the shim's share verb), or remove it; no root there. Returns the key's comment.
 */
export async function shareHost(target: string, publicKey: string, options: { remove?: boolean; run?: ChildRun; knownHosts?: string } = {}) {
  const run = options.run ?? defaultChildRun, knownHosts = options.knownHosts ?? hostKnownHostsFile();
  await ensureKnownHostsDirectory(knownHosts);
  const words = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...hostKeySshOptions(knownHosts), ...sshTarget(target), options.remove ? 'unshare' : 'share'];
  try { await run('sh', ['-c', `printf '%s\\n' ${shellQuote(publicKey)} | ${words.map(shellQuote).join(' ')}`], { timeoutMs: 15_000 }); }
  catch (error: any) { throw new Error(`${target} was not ${options.remove ? 'unshared' : 'shared'}: ${error?.status === 255 || error?.timedOut ? sshFailure(target, error, knownHosts) : lastLine(String(error?.stderr ?? '')).replace(/^graphyard-host-shim refuses: /, '') || `exit ${error?.status}`}`); }
  return publicKey.trim().split(/\s+/)[2] ?? 'that key';
}

export async function removeHost(target: string, options: { file?: string } = {}) {
  const file = options.file ?? hostsFile();
  const hosts = await readHosts(file);
  if (!hosts.some(host => host.target === target)) return { removed: false, hosts };
  const next = hosts.filter(host => host.target !== target);
  await writeHosts(file, next);
  return { removed: true, hosts: next };
}

/** GY-3405: why `target` cannot take agent sessions now, in one line; null when its helper runs them. */
export async function sessionHelperProblem(target: string, run: ChildRun = defaultChildRun): Promise<string | null> {
  const probe = await probeHost(target, run);
  if (probe.ok && probe.verbs?.includes('run-session:1')) return null;
  return probe.ok || probe.update ? `${target}'s helper is older than this release and takes no sessions: run ${hostAddCommand(target)} first` : probe.reason;
}

/** GY-3405: open an added host to `sessions` agent sessions at once (0 closes it to them), once its helper runs them. */
export async function setHostSessions(target: string, sessions: number, options: { file?: string; run?: ChildRun } = {}) {
  const file = options.file ?? hostsFile();
  if (!Number.isSafeInteger(sessions) || sessions < 0 || sessions > 64) throw new Error(`Name how many sessions ${target} takes at once, 0 to 64: got ${sessions}`);
  const hosts = await readHosts(file);
  if (!hosts.some(host => host.target === target)) throw new Error(`${target} is not added: run mainworks host add ${target} first`);
  const problem = sessions ? await sessionHelperProblem(target, options.run) : null;
  if (problem) throw new Error(problem);
  await writeHosts(file, hosts.map(host => host.target === target ? { ...host, sessions } : host));
}

/**
 * One cycle's readings: this machine first, then every recorded host; steal is measured from the previous cycle's counters.
 * GY-3780: with `update` (the loop), a host on another release's shim that speaks update-shim takes this release's and is
 * read again; one whose update fails reads away with the reason.
 */
export async function readHostReadings(previous: HostReading[], options: { file?: string; knownHosts?: string; run?: ChildRun; local?: string; update?: boolean } = {}): Promise<HostReading[]> {
  const knownHosts = options.knownHosts ?? (options.file ? join(dirname(options.file), 'known_hosts') : hostKnownHostsFile());
  const targets = [null, ...(await readHosts(options.file).catch(() => [])).map(host => host.target)];
  return Promise.all(targets.map(async target => {
    const host = target ?? options.local ?? hostname();
    let probe = await probeHost(target, options.run, knownHosts), updateError: string | null = null;
    if (options.update && target && 'shim' in probe && probe.shim !== hostShimDigest && probe.verbs?.includes('update-shim:1')) {
      updateError = await updateHostShim(target, options.run ?? defaultChildRun, knownHosts);
      if (!updateError) {
        probe = await probeHost(target, options.run, knownHosts);
        if ('shim' in probe && probe.shim !== hostShimDigest) updateError = 'it took the update but still runs the older helper';
      }
      if (updateError) probe = { ok: false, update: true, reason: `${target} did not take this release's helper: ${updateError}`, shim: null, verbs: null };
    }
    const at = new Date().toISOString();
    const was = previous.find(reading => reading.host === host);
    if (!probe.ok) return { host, ...(target ? {} : { local: true }), at, away: true, since: was?.away ? was.since ?? was.at ?? at : at, ...('update' in probe ? { update: true } : {}), ...(updateError ? { updateError } : {}), reason: probe.reason, cores: null, celsius: null, steal: null, runs: null, busy: null, stat: null };
    const before = was?.stat ?? null;
    const older = Boolean(target && (probe.shim !== hostShimDigest || (probe.verbs !== null && trialVerbs.some(verb => !probe.verbs!.includes(verb)))));
    return { host, ...(target ? {} : { local: true }), at, away: false, ...(older ? { older: true } : {}), cores: probe.cores, celsius: probe.celsius, steal: stealPercent(before, probe.stat), runs: probe.runs, busy: probe.load, stat: probe.stat };
  }));
}
