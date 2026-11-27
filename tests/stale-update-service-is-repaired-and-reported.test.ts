import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, writeDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { publishCliRelease, resolvedLauncher } from '../src/install/cli-release.js';
import { systemdCommandLineWords } from '../src/install/units.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3756: on an install whose update service's unit still names an old release, the first loop
// running the fixed code points the unit at the install's stable launcher, reloads systemd and
// restarts it; and master status carries one attention line while the update service's own release
// differs from the served one for more than 10 minutes, naming both.

const a = 'a'.repeat(40), b = 'b'.repeat(40);

test('unit:stale-update-service-is-repaired-and-reported — the loop repairs an update service unit naming an old release, and status names both releases after 10 minutes apart', async () => {
  const { runDaemon } = await import('../src/daemon/run.js');
  const { repointDeployUnit } = await import('../src/install/loop-unit.js');
  const { deployReleaseAttention } = await import('../src/daemon/deploy-release.js');
  const home = await temporaryDirectory('stale-update-service');
  const installDir = join(home, 'graphyard', 'owner-project'), source = join(home, 'source'), root = join(home, 'checkout');
  await mkdir(join(source, 'bin'), { recursive: true });
  await writeFile(join(source, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  for (const sha of [a, b]) {
    const tree = join(installDir, 'deploy', 'build', '.graphyard', 'cli-releases', sha);
    await mkdir(join(tree, 'bin'), { recursive: true });
    await writeFile(join(tree, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  }
  await publishCliRelease(installDir, source, a);
  await publishCliRelease(installDir, source, b);
  const unitDirectory = join(home, 'systemd'), unitPath = join(unitDirectory, 'graphyard-deploy.service');
  await mkdir(unitDirectory, { recursive: true });
  const oldLauncher = join(installDir, 'deploy', 'build', '.graphyard', 'cli-releases', a, 'bin', 'graphyard.mjs');
  await writeFile(unitPath, `[Service]\nExecStart=/usr/bin/node ${oldLauncher} upgrade --watch\n`);

  await mkdir(join(root, '.graphyard'), { recursive: true });
  await writeFile(join(root, '.graphyard', 'deploy.json'), JSON.stringify({ tip: b, failed: null, reason: null, at: new Date().toISOString() }));
  const credentialFile = join(root, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:5', credentialFile, cliPath: '/bin/true',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const effects: DaemonEffects = {
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {},
    snapshot: async () => ({ work: [], now: new Date().toISOString() }),
    persist: current => writeDaemonState(config, current),
  };
  const state = emptyDaemonState(config), events: string[] = [];
  let clock = Date.parse('2026-11-24T02:00:00Z'), running = a;
  const cycle = () => runDaemon(config, state, effects, { once: true, intervalMs: 60_000, identity: { pid: process.pid, host: 'machine-a' },
    process: new EventEmitter() as unknown as NodeJS.Process, log: () => {}, root, now: () => clock, restartLoop: async () => {},
    deployUnit: () => ({ unit: 'graphyard-deploy.service', commit: running, busy: false }),
    repointDeploy: unit => repointDeployUnit({ unitPath: join(unitDirectory, unit), installDir, run: (command, args) => { events.push([command, ...args].join(' ')); return ''; } }),
    restartDeploy: async unit => { events.push(`restart ${unit}`); } });

  await cycle();
  assert.deepEqual(events, ['systemctl --user daemon-reload', 'restart graphyard-deploy.service'], 'the unit is rewritten and reloaded before its restart');
  const launcher = systemdCommandLineWords(/^ExecStart=(.+)$/m.exec(await readFile(unitPath, 'utf8'))![1]!)[1]!;
  assert.equal(resolvedLauncher(launcher), join(installDir, 'deploy', 'build', '.graphyard', 'cli-releases', b, 'bin', 'graphyard.mjs'), 'the repaired unit starts the served release');

  // The restart is verified by reading the new process's release: while it still reads A, status warns after 10 minutes.
  assert.deepEqual(deployReleaseAttention(state, clock + 5 * 60_000), [], 'no line inside 10 minutes');
  clock += 11 * 60_000;
  await cycle();
  const lines = deployReleaseAttention(state, clock);
  assert.equal(lines.length, 1, 'one attention line');
  assert.match(lines[0]!.text, new RegExp(`${a.slice(0, 12)}.*${b.slice(0, 12)}`), 'naming both releases');

  running = b;
  await cycle();
  assert.deepEqual(deployReleaseAttention(state, clock + 60 * 60_000), [], 'the line clears once the update service runs the served release');
});
