import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publishCliRelease, resolvedLauncher, sweepCliReleases, unitLauncherFault } from '../src/install/cli-release.js';
import { alignLoopUnit, installLoopSupervisor, loopUnitText } from '../src/install/loop-unit.js';
import { deployUnitOf, perInstallUnits, systemdCommandLineWords } from '../src/install/units.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';
import { patchEnv } from './helpers/env.js';

// GY-4124: Each install's loop runs its own pinned CLI release, never another install's.
// Writing or refreshing an install's loop unit points ExecStart at a CLI release under that
// install's own config directory, and release cleanup never removes a release that any loop
// unit on the machine names.

const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const within = (path: string, parent: string) => {
  const child = resolve(path), root = resolve(parent);
  return child === root || child.startsWith(`${root}/`);
};
const execStartLauncher = (unitText: string) => {
  const match = /^ExecStart=(.+)$/m.exec(unitText);
  assert.ok(match, `unit has ExecStart:\n${unitText}`);
  return systemdCommandLineWords(match[1]!)[1]!;
};

test('integration:loop-unit-pins-own-cli — writing or refreshing a second install created from the first install\'s CLI pins ExecStart under its own config directory, and release cleanup keeps any release a loop unit names', async t => {
  const scratch = realpathSync(await temporaryDirectory('loop-unit-pins-own-cli'));
  const home = join(scratch, 'home');
  const configHome = join(home, '.config', 'graphyard');
  const unitDirectory = join(home, '.config', 'systemd', 'user');
  const installA = join(configHome, 'cryptob1-cortex');
  const installB = join(configHome, 'hello-huck-ohuck');
  const installBRefresh = join(configHome, 'hello-huck-ohuck-refresh');
  const source = join(scratch, 'mainworks-source');
  const rootB = join(scratch, 'ohuck-checkout');
  const rootBRefresh = join(scratch, 'ohuck-refresh-checkout');

  patchEnv({
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GRAPHYARD_CONFIG_HOME: configHome,
    MAINWORKS_CONFIG_HOME: undefined,
  }, t);

  try {

    // 1. Build a real git repo with 4 releases and publish them in install A.
    await gitRepo({ root: source });
    const commits: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      mkdirSync(join(source, 'bin'), { recursive: true });
      writeFileSync(join(source, 'bin', 'graphyard.mjs'), `#!/usr/bin/env node\n// release ${index}\n`);
      git(source, 'add', 'bin/graphyard.mjs');
      git(source, 'commit', '--quiet', '-m', `release ${index}`);
      commits.push(git(source, 'rev-parse', 'HEAD'));
    }

    const storeA = join(installA, 'deploy', 'build', '.graphyard', 'cli-releases');
    mkdirSync(storeA, { recursive: true });
    const copiesA = commits.map((commit, index) => {
      const path = join(storeA, commit);
      git(source, 'worktree', 'add', '--detach', '--quiet', path, commit);
      mkdirSync(join(path, '.graphyard'), { recursive: true });
      writeFileSync(join(path, '.graphyard', 'cli-ready'), commit);
      const readyAt = 1_700_000_000 + index * 3_600;
      utimesSync(join(path, '.graphyard', 'cli-ready'), readyAt, readyAt);
      return path;
    });
    await publishCliRelease(installA, source, commits[3]!);
    const cliFromA = join(copiesA[3]!, 'bin', 'graphyard.mjs');

    const stubHost = () => ({
      home,
      temporaryDirectories: [join(scratch, 'volatile')],
      run: (_command: string, args: string[]) => (args.includes('is-enabled') ? 'enabled' : args.includes('is-active') ? 'active' : ''),
    });

    // 2. Writing install B's loop unit from install A's CLI pins ExecStart under install B's own directory.
    await mkdir(join(rootB, '.graphyard'), { recursive: true });
    await writeFile(join(rootB, '.graphyard', 'master.json'), JSON.stringify({ repository: 'hello-huck/ohuck', cliPath: cliFromA }));
    const created = await installLoopSupervisor(
      { root: rootB, cliPath: cliFromA, repository: 'hello-huck/ohuck', intervalSeconds: 20, execPath: '/usr/bin/node', installDir: installB },
      stubHost(),
    );
    assert.equal(created.wrote, 'created');
    const unitBText = await readFile(created.unitPath!, 'utf8');
    const launcherB = execStartLauncher(unitBText);
    assert.ok(within(launcherB, installB), `ExecStart launcher must be under install B (${installB}), got ${launcherB}`);
    assert.ok(!within(launcherB, installA), `ExecStart launcher must never be under install A (${installA}), got ${launcherB}`);
    const resolvedB = resolvedLauncher(launcherB);
    assert.ok(resolvedB && within(resolvedB, installB), `resolved launcher must live under install B (${installB}), got ${resolvedB}`);
    assert.equal(unitLauncherFault({ unit: created.unit, launcher: launcherB, installDir: installB, configHome }), null);
    const deployBText = await readFile(join(unitDirectory, deployUnitOf({ master: created.unit })), 'utf8');
    const deployLauncherB = execStartLauncher(deployBText);
    assert.ok(within(deployLauncherB, installB), `deploy unit ExecStart must be under install B (${installB}), got ${deployLauncherB}`);

    // 3. Refreshing a second install whose unit was originally created pointing at install A's CLI
    //    rewrites ExecStart onto a CLI release under its own config directory.
    await mkdir(join(rootBRefresh, '.graphyard'), { recursive: true });
    await writeFile(join(rootBRefresh, '.graphyard', 'master.json'), JSON.stringify({ repository: 'hello-huck/ohuck-refresh', cliPath: cliFromA }));
    const refreshUnits = perInstallUnits('hello-huck/ohuck-refresh');
    await writeFile(join(rootBRefresh, '.graphyard', 'units.json'), JSON.stringify(refreshUnits));
    const refreshUnitPath = join(unitDirectory, refreshUnits.master);
    await mkdir(unitDirectory, { recursive: true });
    await writeFile(
      refreshUnitPath,
      loopUnitText({ root: rootBRefresh, cliPath: cliFromA, repository: 'hello-huck/ohuck-refresh', intervalSeconds: 20, execPath: '/usr/bin/node', installDir: installBRefresh }),
    );
    assert.ok(within(execStartLauncher(await readFile(refreshUnitPath, 'utf8')), installA), 'precondition: existing unit points at install A\'s CLI');

    const refreshed = await alignLoopUnit(
      { root: rootBRefresh, cliPath: cliFromA, repository: 'hello-huck/ohuck-refresh', intervalSeconds: 20, execPath: '/usr/bin/node', installDir: installBRefresh },
      stubHost(),
    );
    assert.equal(refreshed.wrote, 'updated', `refresh should rewrite the foreign unit: ${JSON.stringify(refreshed)}`);
    const refreshedText = await readFile(refreshUnitPath, 'utf8');
    const refreshedLauncher = execStartLauncher(refreshedText);
    assert.ok(within(refreshedLauncher, installBRefresh), `refreshed ExecStart must be under install B (${installBRefresh}), got ${refreshedLauncher}`);
    assert.ok(!within(refreshedLauncher, installA), `refreshed ExecStart must never be under install A (${installA}), got ${refreshedLauncher}`);
    const refreshedResolved = resolvedLauncher(refreshedLauncher);
    assert.ok(refreshedResolved && within(refreshedResolved, installBRefresh), `refreshed resolved launcher must live under install B (${installBRefresh}), got ${refreshedResolved}`);
    assert.equal(unitLauncherFault({ unit: refreshUnits.master, launcher: refreshedLauncher, installDir: installBRefresh, configHome }), null);

    // A second refresh is idempotent.
    const secondRefresh = await alignLoopUnit(
      { root: rootBRefresh, cliPath: cliFromA, repository: 'hello-huck/ohuck-refresh', intervalSeconds: 20, execPath: '/usr/bin/node', installDir: installBRefresh },
      stubHost(),
    );
    assert.equal(secondRefresh.wrote, 'unchanged');

    // 4. Release cleanup never removes a release that any loop unit on the machine names,
    //    while still removing older releases nothing names.
    const pinnedUnitPath = join(unitDirectory, 'graphyard-master-pinned-other.service');
    await writeFile(pinnedUnitPath, `[Service]\nWorkingDirectory=${scratch}\nExecStart=/usr/bin/node ${join(copiesA[0]!, 'bin', 'graphyard.mjs')} master run\n`);
    const swept = await sweepCliReleases(installA, run);
    assert.equal(existsSync(copiesA[0]!), true, 'release named by a loop unit on the machine must be kept');
    assert.equal(existsSync(copiesA[1]!), false, 'old release not named by any unit or live process is removed');
    assert.deepEqual(swept.removed, [copiesA[1]!]);
    assert.equal(existsSync(copiesA[2]!), true, 'previous release stays');
    assert.equal(existsSync(copiesA[3]!), true, 'served release stays');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
