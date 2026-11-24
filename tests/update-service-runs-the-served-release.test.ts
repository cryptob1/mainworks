import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishCliRelease, resolvedLauncher } from '../src/install/cli-release.js';
import { systemdCommandLineWords } from '../src/install/units.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3756: a following install's update service (the deploy unit, `upgrade --watch`) runs the
// release it just installed, not the one it was first set up with. Its unit starts the install's
// stable launcher, which resolves the served release; and a unit still naming a release path is
// rewritten by the watch's handover, with systemd reloaded, before the restart that loads it.

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const releaseTree = async (installDir: string, sha: string) => {
  const tree = join(installDir, 'deploy', 'build', '.graphyard', 'cli-releases', sha);
  await mkdir(join(tree, 'bin'), { recursive: true });
  await writeFile(join(tree, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  return tree;
};
const launcherOf = (unit: string) => systemdCommandLineWords(/^ExecStart=(.+)$/m.exec(unit)![1]!).find(word => word.endsWith('/bin/graphyard.mjs'))!;

test('unit:update-service-runs-the-served-release — the update service set up on release A runs B after the update to B, and a failed unit rewrite is reported without a restart loop', async () => {
  const { deployUnitText, repointDeployUnit } = await import('../src/install/loop-unit.js');
  const { releaseHandover } = await import('../src/deploy-watch.js');
  const home = await temporaryDirectory('update-service-release');
  const installDir = join(home, 'graphyard', 'owner-project'), root = join(home, 'checkout'), source = join(home, 'source');
  await mkdir(join(source, 'bin'), { recursive: true });
  await writeFile(join(source, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  const treeA = await releaseTree(installDir, a), treeB = await releaseTree(installDir, b);
  await publishCliRelease(installDir, source, a);

  // Set up on release A: the configured CLI is A's own launcher, yet the unit starts the install's stable one.
  const unit = deployUnitText({ root, cliPath: join(treeA, 'bin', 'graphyard.mjs'), repository: 'owner/project', execPath: '/usr/bin/node', installDir });
  assert.equal(resolvedLauncher(launcherOf(unit)), join(treeA, 'bin', 'graphyard.mjs'));
  await publishCliRelease(installDir, source, b);
  assert.equal(resolvedLauncher(launcherOf(unit)), join(treeB, 'bin', 'graphyard.mjs'), 'after the update to B the unit\'s command runs B');

  // A unit written before the fix names release A's path: the handover rewrites it, reloads systemd, then restarts.
  const unitDirectory = join(home, 'systemd'), unitPath = join(unitDirectory, 'graphyard-deploy.service');
  await mkdir(unitDirectory, { recursive: true });
  await writeFile(unitPath, `[Service]\nExecStart=/usr/bin/node ${join(treeA, 'bin', 'graphyard.mjs')} upgrade --watch --checkout ${join(installDir, 'deploy', 'src')}\nRestart=always\n`);
  const calls: string[][] = [], logs: string[] = [];
  let stops = 0;
  const handover = releaseHandover(() => a, () => { stops++; }, () => repointDeployUnit({ unitPath, installDir, run: (command, args) => { calls.push([command, ...args]); return ''; } }), line => logs.push(line));
  await assert.rejects(handover(b), (error: any) => error.releaseHandover === true);
  assert.equal(stops, 1);
  assert.deepEqual(calls, [['systemctl', '--user', 'daemon-reload']]);
  const rewritten = await readFile(unitPath, 'utf8');
  assert.equal(resolvedLauncher(launcherOf(rewritten)), join(treeB, 'bin', 'graphyard.mjs'), 'the rewritten unit starts B');
  assert.match(rewritten, /upgrade --watch --checkout /);

  // A rewrite that fails is reported once and withholds the restart, so the watch does not restart onto A again and again.
  await writeFile(unitPath, `[Service]\nExecStart=/usr/bin/node ${join(treeA, 'bin', 'graphyard.mjs')} upgrade --watch\n`);
  await chmod(unitDirectory, 0o555);
  try {
    const failing = releaseHandover(() => a, () => { stops++; }, () => repointDeployUnit({ unitPath, installDir, run: () => '' }), line => logs.push(line));
    await failing(b);
    await failing(b);
  } finally { await chmod(unitDirectory, 0o755); }
  assert.equal(stops, 1, 'no restart follows a failed rewrite');
  const reported = logs.filter(line => line.includes('stays on'));
  assert.equal(reported.length, 1, 'the failure is reported once per served release');
  assert.match(reported[0]!, new RegExp(`${a.slice(0, 12)}.*${b.slice(0, 12)}`));
});
