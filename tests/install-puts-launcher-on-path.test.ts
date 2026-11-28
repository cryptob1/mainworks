import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { applyInstall, buildPlan, prepareInstall } from '../src/install/index.js';
import { cliReleasePath, currentCliPath, userLauncherPath, writeUserLauncher } from '../src/install/cli-release.js';
import { freeLoopbackPort } from '../src/install/local.js';
import { LOCAL_USER, localPaths, postgresBinaries, startCluster } from '../src/install/local-runtime.js';
import { liveServersUnder } from '../src/postgres-stop.js';
import { harness, REPOSITORY } from './install-harness.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3836 AC-1: After install or upgrade, `mainworks` resolves in the owner's login shell and runs
// the install's current CLI for the checkout in the working directory (or the only install when
// there is one); it survives a deploy to a new release without being rewritten by hand.
// `install --plan` lists the launcher.

const proof = 'integration:install-puts-launcher-on-path';

async function writeFakeCli(directory: string, label: string) {
  const file = join(directory, 'bin', 'graphyard.mjs');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(label)} + ' ' + process.argv.slice(2).join(' '));\n`);
  await chmod(file, 0o755);
  return file;
}

test(`${proof} — install --plan lists the launcher; install puts mainworks on the login shell PATH, resolves the checkout or sole install, and survives a deploy to a new release`, async () => {
  const home = await temporaryDirectory('launcher-home');
  const configHome = join(home, '.config', 'mainworks');
  const h = await harness({ provider: 'local', configHome });
  const fakeInitialCli = await writeFakeCli(join(home, 'initial-cli'), 'release-initial');
  const deps = { ...h.deps, home, cliPath: fakeInitialCli };
  try {
    // 1. install --plan lists the launcher before it exists.
    const planSession = await prepareInstall(h.root, { provider: 'local', repository: REPOSITORY }, deps, 'plan');
    const plan = await buildPlan(planSession);
    const launcherAction = plan.actions.find(action => action.id === 'local.launcher');
    assert.ok(launcherAction, 'install --plan must list local.launcher');
    assert.equal(launcherAction.state, 'create');
    assert.ok(
      launcherAction.title.includes(userLauncherPath(home)) || launcherAction.values?.some(v => v.value === userLauncherPath(home)),
      'plan action names the launcher path',
    );

    // 2. install --apply writes the launcher at ~/.local/bin/mainworks.
    const applySession = await prepareInstall(h.root, { provider: 'local', repository: REPOSITORY }, deps, 'apply');
    await applyInstall(applySession, await buildPlan(applySession));

    const env = {
      HOME: home,
      PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      MAINWORKS_CONFIG_HOME: configHome,
    };

    // Resolves in the owner's login shell.
    const resolved = execFileSync('bash', ['-lc', 'command -v mainworks'], { env, encoding: 'utf8' }).trim();
    assert.equal(resolved, userLauncherPath(home), 'mainworks resolves in the owner login shell');

    // Runs the install's CLI from inside the checkout AND from outside (as the only install).
    assert.equal(
      execFileSync('bash', ['-lc', 'mainworks status GY-1'], { cwd: h.root, env, encoding: 'utf8' }).trim(),
      'release-initial status GY-1',
    );
    assert.equal(
      execFileSync('bash', ['-lc', 'mainworks host list'], { cwd: home, env, encoding: 'utf8' }).trim(),
      'release-initial host list',
    );

    // 3. Survives a deploy to a new release without rewriting ~/.local/bin/mainworks.
    const installDir = join(configHome, 'owner-project');
    const beforeLauncher = await readFile(userLauncherPath(home), 'utf8');
    const sha1 = '1'.repeat(40);
    const sha2 = '2'.repeat(40);
    const rel1 = cliReleasePath(installDir, sha1);
    const rel2 = cliReleasePath(installDir, sha2);
    await writeFakeCli(rel1, 'release-one');
    await writeFakeCli(rel2, 'release-two');
    const current = currentCliPath(installDir);
    await mkdir(dirname(current), { recursive: true });
    await symlink(rel1, current);

    assert.equal(
      execFileSync('bash', ['-lc', 'mainworks version'], { cwd: h.root, env, encoding: 'utf8' }).trim(),
      'release-one version',
      'runs the published release once cli-published exists',
    );

    // Swing cli-published to sha2 (a deploy to a new release).
    await unlink(current);
    await symlink(rel2, current);

    assert.equal(
      execFileSync('bash', ['-lc', 'mainworks version'], { cwd: h.root, env, encoding: 'utf8' }).trim(),
      'release-two version',
      'automatically runs the new release after deploy without rewriting the launcher',
    );
    assert.equal(
      execFileSync('bash', ['-lc', 'mainworks version'], { cwd: home, env, encoding: 'utf8' }).trim(),
      'release-two version',
      'runs the new release from outside the checkout when it is the only install',
    );
    assert.equal(await readFile(userLauncherPath(home), 'utf8'), beforeLauncher, 'launcher file was not rewritten');

    // 4. Re-planning after install reports local.launcher as satisfied; upgrade keeps it.
    const replan = await buildPlan(await prepareInstall(h.root, { provider: 'local', repository: REPOSITORY }, deps, 'plan'));
    assert.equal(replan.actions.find(action => action.id === 'local.launcher')?.state, 'satisfied');

    await writeUserLauncher({ home });
    assert.equal(
      execFileSync('bash', ['-lc', 'mainworks version'], { cwd: h.root, env, encoding: 'utf8' }).trim(),
      'release-two version',
    );
  } finally {
    await h.cleanup();
  }
});

test('integration:install-cleanup-stops-postgres-first — harness cleanup stops local Postgres and waits for it to exit before removing directories', async () => {
  const h = await harness({ provider: 'local' });
  const paths = localPaths(join(h.configHome, 'owner-project'));
  const password = 'test-cleanup-password';
  await mkdir(paths.postgres, { recursive: true, mode: 0o700 });
  await writeFile(paths.passwordFile, `${password}\n`, { mode: 0o600 });
  const binaries = await postgresBinaries();
  execFileSync(binaries.initdb, [
    `--pgdata=${paths.data}`, '--auth=scram-sha-256', `--username=${LOCAL_USER}`,
    `--pwfile=${paths.passwordFile}`, '--encoding=UTF8', '--locale=C', '--no-sync',
  ], { stdio: 'ignore' });
  await appendFile(join(paths.data, 'postgresql.auto.conf'), 'fsync = off\n');
  const port = await freeLoopbackPort();
  const cluster = await startCluster(paths, port, binaries);

  // Actively write relation files into the data directory so removing configHome while Postgres is
  // still running races with file creation and fails with ENOTEMPTY.
  let writing = true;
  const clients = await Promise.all(Array.from({ length: 4 }, async () => {
    const client = new pg.Client({ host: '127.0.0.1', port, user: LOCAL_USER, password, database: 'postgres' });
    client.on('error', () => {});
    await client.connect();
    return client;
  }));
  const started = clients.map(() => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
  });
  const writers = clients.map((client, worker) => (async () => {
    try {
      for (let i = 0; writing; i++) {
        await client.query(`CREATE TABLE w_${worker}_${i} (x int); DROP TABLE w_${worker}_${i};`);
        if (i === 0) started[worker].resolve();
      }
    } catch {
      started[worker].resolve();
      // Expected once cleanup stops Postgres with fast shutdown.
    } finally {
      await client.end().catch(() => {});
    }
  })());
  await Promise.all(started.map(s => s.promise));

  try {
    await h.cleanup();
    assert.deepEqual(liveServersUnder(h.configHome), [], 'local Postgres exited before cleanup returned');
    assert.equal(existsSync(h.configHome), false, 'configHome was removed after Postgres stopped');
  } finally {
    writing = false;
    await Promise.allSettled(writers);
    await cluster.stop();
  }
});
