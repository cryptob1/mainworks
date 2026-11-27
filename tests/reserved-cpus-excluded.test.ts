import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { composeBounds, composePreviewConfig, composeProjectName } from '../src/compose-preview.js';
import { allowedCpus } from '../src/reserved-cpus.js';
import { detachedLaunch, runFiles, sessionLaunch } from '../src/runner/pi.js';
import { systemdContainment } from '../src/session-watch.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4006: with MAINWORKS_RESERVED_CPUS set, everything Mainworks starts on the host stays off those
// CPUs: session and trial scopes (AllowedCPUs, and the affinity that holds where the user manager has
// no cpuset controller), and the Docker containers of trials, checks and their services. A live
// scope needs a systemd user manager, which a merge trial's container lacks: there that reading is
// skipped, and the post-deploy reading (AC-4) shows it on the serving host.
const proof = 'integration:reserved-cpus-excluded';

/** A CPU list such as `0-3,8` as the numbers it names. */
const cpus = (list: string) => list.trim().split(',').flatMap(part => { const [first, last = first] = part.split('-').map(Number) as [number, number?]; return Array.from({ length: last - first + 1 }, (_, index) => first + index); });
/** This host's CPUs, as a list such as `0-23`. */
const online = () => readFileSync('/sys/devices/system/cpu/online', 'utf8').trim();
/** Reserves 0-3 as the owner's host does, never more than leaves this host two CPUs. */
const reserved = `0-${Math.min(3, cpus(online()).length - 3)}`;
/** The host's CPUs less the reserved ones, as numbers: a host's own count does not matter. */
const others = () => cpus(online()).filter(cpu => !cpus(reserved).includes(cpu));
const allowedOf = (words: readonly string[]) => {
  const word = words.find(item => item.startsWith('AllowedCPUs='));
  assert.ok(word, `no AllowedCPUs among ${JSON.stringify(words)}`);
  return word.slice('AllowedCPUs='.length);
};
/** The CPU set the kernel lets a process use, from the `Cpus_allowed_list` line it printed of its own status. */
const allowedByKernel = (status: string | undefined) => status?.split('\t')[1]?.trim() ?? '';
const composeServices = () => composePreviewConfig({ services: { web: { image: 'web', cpuset: reserved }, db: { image: 'postgres:16' } } },
  { project: composeProjectName('GY-4006', 'test'), service: 'web', port: 8080, bounds: composeBounds(), variables: {}, owner: { pid: process.pid } as never });

/** Runs `body` with the host setting (`undefined`: none), then puts the caller's back. */
async function withReserved<T>(value: string | undefined, body: () => T): Promise<T> {
  const before = process.env.MAINWORKS_RESERVED_CPUS;
  if (value === undefined) delete process.env.MAINWORKS_RESERVED_CPUS; else process.env.MAINWORKS_RESERVED_CPUS = value;
  try { return await body(); } finally { if (before === undefined) delete process.env.MAINWORKS_RESERVED_CPUS; else process.env.MAINWORKS_RESERVED_CPUS = before; }
}

test(`${proof} — launch properties keep session, trial and check launches off reserved CPUs`, () => withReserved(reserved, () => {
  const scopes = [
    ['worker', sessionLaunch('/tmp/run', 'worker', 'true', [], 'systemd')],
    ['reviewer', sessionLaunch('/tmp/run', 'reviewer', 'true', [], 'systemd')],
    ['producer', sessionLaunch('/tmp/run', 'producer', 'true', [], 'systemd')],
    ['trial', detachedLaunch('/tmp/run', 'trial', 'true', [], 'systemd')],
    ['watched worker', systemdContainment('true', [], (() => '') as unknown as typeof execFileSync)],
  ] as const;
  for (const [name, launch] of scopes) {
    assert.deepEqual(cpus(allowedOf(launch.args)), others(), `${name} scope carries AllowedCPUs without the reserved CPUs`);
    const command = launch.args.indexOf('--') + 1;
    assert.deepEqual(launch.args.slice(command, command + 2), ['taskset', '-c'], `${name} starts under one CPU affinity`);
    assert.deepEqual(cpus(launch.args[command + 2]!), others(), `${name} affinity leaves out the reserved CPUs`);
  }
  const plain = sessionLaunch('/tmp/run', 'setsid', 'true', [], 'setsid');
  assert.deepEqual([plain.file, ...plain.args.slice(0, 2)], ['taskset', '-c', allowedCpus(reserved, online())], 'a run with no scope starts under the same affinity');
  const trial = JSON.parse(trialContainerLaunch({ image: 'trial', mounts: [], network: 'none' }).at(-1)!) as { allowedCpus?: string };
  assert.deepEqual(cpus(trial.allowedCpus ?? ''), others(), 'the Docker trial container receives the same CPU set');
  for (const [name, service] of Object.entries<{ cpuset?: string }>(composeServices().services))
    assert.deepEqual(cpus(service.cpuset ?? ''), others(), `Compose service ${name} runs on the same CPU set, whatever its file declares`);
}));

test(`${proof} — launch properties with no reservation name no CPUs`, () => withReserved(undefined, () => {
  for (const launch of [sessionLaunch('/tmp/run', 'worker', 'true', [], 'systemd'), detachedLaunch('/tmp/run', 'trial', 'true', [], 'setsid'), systemdContainment('true', [], (() => '') as unknown as typeof execFileSync)])
    assert.ok(!launch.args.some(word => /AllowedCPUs|taskset/.test(word)), JSON.stringify(launch.args));
  assert.equal(allowedCpus('', online()), undefined);
  assert.equal(JSON.parse(trialContainerLaunch({ image: 'trial', mounts: [], network: 'none' }).at(-1)!)?.allowedCpus, undefined);
  assert.equal((composeServices().services.web as { cpuset?: string }).cpuset, reserved, "a Compose file's own cpuset stands");
}));

test(`${proof} — a session and a trial child started with the setting run only on the other CPUs`, async () => withReserved(reserved, async () => {
  const base = await temporaryDirectory('reserved-cpus');
  for (const [name, launch] of [['session', sessionLaunch], ['trial', detachedLaunch]] as const) {
    const directory = join(base, name), id = `reserved-${name}-${process.pid}`;
    mkdirSync(directory);
    const command = launch(directory, id, 'sh', ['-c', 'grep Cpus_allowed_list /proc/self/status'], 'setsid');
    const child = spawn(command.file!, command.args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let error = '';
    child.stderr!.on('data', chunk => { error += chunk; });
    const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(20_000) });
    const allowed = allowedByKernel(readFileSync(runFiles(directory).stdout, 'utf8'));
    assert.deepEqual([code, cpus(allowed)], [0, others()], `${name} child ended with ${code} and its kernels's CPU list is ${allowed}: ${error.trim()}`);
  }
}));

const hostOnly = (() => { try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5_000 }); return false; } catch { return 'no systemd user manager answers here'; } })();

test(`${proof} — a session scope and a trial scope report AllowedCPUs without the reserved CPUs`, { skip: hostOnly }, async () => withReserved(reserved, async () => {
  const base = await temporaryDirectory('reserved-cpus-scope');
  for (const [name, launch] of [['session', sessionLaunch], ['trial', detachedLaunch]] as const) {
    const directory = join(base, name), id = `reserved-scope-${name}-${process.pid}`;
    mkdirSync(directory);
    const command = launch(directory, id, 'sh', ['-c', 'grep Cpus_allowed_list /proc/self/status; sleep 20'], 'systemd');
    const child = spawn(command.file!, command.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '', allowed = '';
    child.stderr!.on('data', chunk => { error += chunk; });
    try {
      for (let attempt = 0; attempt < 50 && !allowed && child.exitCode === null; attempt++) {
        try { allowed = execFileSync('systemctl', ['--user', 'show', command.unit!, '--property=AllowedCPUs', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch {}
        if (!allowed) await delay(100);
      }
      assert.deepEqual(cpus(allowed), others(), `${name} scope reports AllowedCPUs ${allowed || 'none'}: ${error.trim()}`);
    } finally {
      try { execFileSync('systemctl', ['--user', 'stop', command.unit!], { stdio: 'ignore' }); } catch {}
      child.kill();
    }
    const kernel = allowedByKernel(readFileSync(runFiles(directory).stdout, 'utf8'));
    assert.deepEqual(cpus(kernel), others(), `${name} scope's process may use ${kernel || 'an unreadable CPU list'}`);
  }
}));
