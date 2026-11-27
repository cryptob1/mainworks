import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { detachedLaunch, sessionLaunch } from '../src/runner/pi.js';
import { systemdContainment } from '../src/session-watch.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { allowedCpus } from '../src/reserved-cpus.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const proof = 'integration:reserved-cpus-excluded';

test(`${proof} — session and trial launch properties exclude reserved CPUs`, () => {
  const before = process.env.MAINWORKS_RESERVED_CPUS;
  process.env.MAINWORKS_RESERVED_CPUS = '0-3';
  try {
    const expected = readFileSync('/sys/devices/system/cpu/online', 'utf8').trim().replace(/^0-/, '4-');
    const launches = [
      sessionLaunch('/tmp/run', 'worker', 'true', [], 'systemd'),
      sessionLaunch('/tmp/run', 'reviewer', 'true', [], 'systemd'),
      sessionLaunch('/tmp/run', 'producer', 'true', [], 'systemd'),
      detachedLaunch('/tmp/run', 'trial', 'true', [], 'systemd'),
      systemdContainment('true', [], (() => '') as unknown as typeof execFileSync),
    ];
    for (const launch of launches) assert.ok(launch.args.includes(`AllowedCPUs=${expected}`), JSON.stringify(launch.args));
    const spec = JSON.parse(trialContainerLaunch({ image: 'trial', mounts: [], network: 'none' }).at(-1)!);
    assert.equal(spec.allowedCpus, expected, 'Docker checks receive the same host CPU set');
  } finally {
    if (before === undefined) delete process.env.MAINWORKS_RESERVED_CPUS; else process.env.MAINWORKS_RESERVED_CPUS = before;
  }
});

test(`${proof} — starts a session and trial child and reads their AllowedCPUs`, async () => {
  const before = process.env.MAINWORKS_RESERVED_CPUS;
  process.env.MAINWORKS_RESERVED_CPUS = '0-3';
  const directory = await temporaryDirectory('reserved-cpus');
  try {
    for (const [name, launch] of [['session', sessionLaunch], ['trial', detachedLaunch]] as const) {
      const command = launch(directory, `reserved-${name}-${process.pid}`, '/bin/sleep', ['30'], 'systemd');
      const child = spawn(command.file!, command.args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = '';
      child.stderr!.on('data', chunk => { error += chunk; });
      try {
        let allowed = '';
        for (let attempt = 0; attempt < 30; attempt++) {
          try { allowed = execFileSync('systemctl', ['--user', 'show', command.unit!, '--property=AllowedCPUs', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch {}
          if (allowed || child.exitCode !== null) break;
          await delay(100);
        }
        assert.equal(allowed, readFileSync('/sys/devices/system/cpu/online', 'utf8').trim().replace(/^0-/, '4-'), error || 'scope did not report AllowedCPUs');
      } finally {
        try { execFileSync('systemctl', ['--user', 'stop', command.unit!], { stdio: 'ignore' }); } catch {}
        child.kill();
      }
    }
  } finally {
    if (before === undefined) delete process.env.MAINWORKS_RESERVED_CPUS; else process.env.MAINWORKS_RESERVED_CPUS = before;
  }
});

test(`${proof} — no reservation leaves placement unchanged; lists use host CPU IDs`, () => {
  assert.equal(allowedCpus('', '0-23'), undefined);
  assert.equal(allowedCpus('0-3', '0-23'), '4-23');
  assert.equal(allowedCpus('0,2-3', '0-7'), '1,4-7');
  assert.equal(allowedCpus('0-3', '0-3,8-11'), '8-11');
});
