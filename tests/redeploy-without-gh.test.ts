import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { freePort } from '../src/cli/test-isolation.js';
import { gitWatchPorts } from '../src/cli/upgrade.js';
import { defaultChildRun } from '../src/child-runner.js';
import { deployRecordPath, readDeployRecord, watchMain, type DeployWatchPorts } from '../src/deploy-watch.js';
import { applyInstall, buildPlan, installRequestFromArgs, prepareInstall, redeployArguments } from '../src/install/index.js';
import { DEPLOY_KEY_FILE } from '../src/install/deploy-key.js';
import { installDirectory, readInstallRecord, tokenFile } from '../src/install/secrets.js';
import { Store } from '../src/store.js';
import { startPostgres } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { harness, type Harness } from './install-harness.js';
import { git } from './helpers/git-repo.js';

// GY-3653: the deploy watch's restart of an existing install whose deploy key is already registered
// never needs the GitHub CLI, so a missing or unauthenticated gh login never stops a verified commit
// from deploying. A first install without gh still fails preflight with the gh login fix and changes nothing.

const GH_FAILING = { match: 'gh ', result: { stdout: '', stderr: 'gh: not logged in', code: 1 } };

async function apply(fixture: Harness, args: string[]) {
  const { request } = installRequestFromArgs(args);
  const session = await prepareInstall(fixture.root, request, fixture.deps, 'apply');
  const plan = await buildPlan(session);
  return { session, plan, summary: await applyInstall(session, plan) };
}

test('integration:redeploy-without-gh — redeploying an existing install succeeds with gh failing, while a first install without gh still prints the gh login fix and changes nothing', async () => {
  // 1. A first install without gh still refuses preflight with the gh login fix and writes nothing.
  const fresh = await harness({
    provider: 'compose', serverUrl: 'http://127.0.0.1:4310',
    extraResponses: [GH_FAILING],
  });
  try {
    await assert.rejects(
      apply(fresh, ['--provider', 'compose', '--repo', 'owner/project', '--apply']),
      (error: Error) => /Preflight is incomplete; the installer changed nothing/.test(error.message)
        && /gh auth login --scopes repo \(the account must administer owner\/project\)/.test(error.message),
      'a first install without gh still fails preflight naming the gh login fix',
    );
    assert.deepEqual(await readdir(fresh.configHome), [], 'a refused first install creates nothing');
  } finally { await fresh.cleanup(); }

  // 2. An existing install whose deploy key is already registered redeploys through the deploy
  // watch's restart arguments even when gh is missing or unauthenticated in the environment.
  const initial = await harness({ provider: 'compose', serverUrl: 'http://127.0.0.1:4310' });
  try {
    const first = await apply(initial, ['--provider', 'compose', '--repo', 'owner/project', '--apply']);
    const directory = installDirectory('owner-project', initial.configHome);
    assert.equal(first.summary.deployKey, join(directory, DEPLOY_KEY_FILE));
    assert.ok(existsSync(join(directory, DEPLOY_KEY_FILE)), 'the first install created the deploy key');
    const record = await readInstallRecord(directory);
    assert.ok(record, 'the first install wrote install.json');

    const redeploy = await harness({
      provider: 'compose', serverUrl: 'http://127.0.0.1:4310',
      root: initial.root, configHome: initial.configHome, installed: true,
      extraResponses: [GH_FAILING],
    });
    const args = redeployArguments(record, 'mainworks-local:abcdef123456');
    const planSession = await prepareInstall(redeploy.root, installRequestFromArgs([...args.slice(0, -1), '--plan']).request, redeploy.deps, 'plan');
    const plan = await buildPlan(planSession);
    assert.ok(plan.preflight.every(item => item.ok), `redeploy --plan preflight passed without gh: ${JSON.stringify(plan.preflight.filter(item => !item.ok))}`);

    const { summary } = await apply(redeploy, args);
    assert.equal(summary.health, true);
    assert.equal(summary.deployKey, join(directory, DEPLOY_KEY_FILE));
    assert.deepEqual(redeploy.allCommandLines().filter(line => line.startsWith('gh ')), [], 'redeploy never invokes gh');
  } finally { await initial.cleanup(); }
});

test('e2e:redeploy-without-gh — a newly verified commit reaches the control plane\'s /healthz without a GitHub CLI login', { timeout: 180_000 }, async () => {
  const cluster = await startPostgres();
  const admin = new pg.Client({ connectionString: cluster.url });
  await admin.connect();
  try { await admin.query('CREATE DATABASE graphyard'); } finally { await admin.end(); }
  const databaseUrl = new URL(cluster.url);
  databaseUrl.pathname = '/graphyard';
  const store = new Store(databaseUrl.href);
  try { await store.init(); } finally { await store.close(); }

  const base = await temporaryDirectory('redeploy-without-gh-git');
  const origin = join(base, 'origin.git'), pusher = join(base, 'pusher'), checkout = join(base, 'checkout');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, pusher);
  await writeFile(join(pusher, 'release.txt'), 'A\n');
  git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'A'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
  const commitA = git(pusher, 'rev-parse', 'HEAD');
  git(base, 'clone', '-q', origin, checkout);
  git(checkout, 'checkout', '-q', '--detach', commitA);

  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const repoRoot = new URL('..', import.meta.url).pathname;
  let server: ChildProcess | null = null;
  let adminToken = 'a'.repeat(32);

  const startServer = async (commit: string) => {
    if (server && server.exitCode === null) await new Promise(resolve => { server!.once('exit', resolve); server!.kill(); });
    const { DATABASE_URL: _d, GRAPHYARD_VERSION: _v, GRAPHYARD_BUILD_REVISION: _r, GRAPHYARD_BUILD_SHA: _s, ...host } = process.env;
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: repoRoot, stdio: 'ignore',
      env: {
        ...host,
        DATABASE_URL: databaseUrl.href,
        HOST: '127.0.0.1',
        PORT: String(port),
        GITHUB_REPOSITORY: 'owner/project',
        GRAPHYARD_VERSION: `unreleased ${commit.slice(0, 12)}`,
        GRAPHYARD_BUILD_REVISION: commit,
        GRAPHYARD_PRINCIPALS: JSON.stringify([{ id: 'owner-project-operator', role: 'admin', sessionKind: 'human', token: adminToken }]),
      },
    });
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const response = await fetch(`${url}/healthz`);
        const body = await response.json() as { ok?: boolean; commit?: string };
        if (response.ok && body.ok && body.commit === commit) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`control plane never answered /healthz at ${commit}`);
  };

  const initial = await harness({ provider: 'compose', serverUrl: url });
  try {
    // First install with a working gh login registers the deploy key and writes install.json.
    await apply(initial, ['--provider', 'compose', '--repo', 'owner/project', '--port', String(port), '--apply']);
    const directory = installDirectory('owner-project', initial.configHome);
    const record = await readInstallRecord(directory);
    assert.ok(record);
    // Use the installed admin token so authenticated /api/status hits the real control plane.
    const { readFile } = await import('node:fs/promises');
    adminToken = (await readFile(tokenFile(directory, 'owner-project-operator'), 'utf8')).trim();
    await startServer(commitA);

    // Push a newly verified commit B.
    await writeFile(join(pusher, 'release.txt'), 'B\n');
    git(pusher, 'add', '.'); git(pusher, 'commit', '-q', '-m', 'B'); git(pusher, 'push', '-q', 'origin', 'HEAD:main');
    const commitB = git(pusher, 'rev-parse', 'HEAD');

    const recordDir = await temporaryDirectory('redeploy-without-gh-record');
    await mkdir(recordDir, { recursive: true });
    const deployFile = deployRecordPath(recordDir);
    const tree = gitWatchPorts(checkout, defaultChildRun);
    let redeployGhCalls: string[] = [];

    const ports: DeployWatchPorts = {
      ...tree,
      build: async () => {},
      restart: async commit => {
        // The deploy watch's restart path: install --plan then install --apply with gh failing.
        const redeploy = await harness({
          provider: 'compose', serverUrl: url,
          root: initial.root, configHome: initial.configHome, installed: true,
          extraResponses: [GH_FAILING],
        });
        const args = redeployArguments(record, `mainworks-local:${commit.slice(0, 12)}`);
        const liveDeps = { ...redeploy.deps, fetch };
        // Restart the real control plane stamped with the new commit when the adapter deploys.
        const basePrepare = await prepareInstall(redeploy.root, installRequestFromArgs(args).request, liveDeps, 'apply');
        const originalDeploy = basePrepare.adapter.deploy.bind(basePrepare.adapter);
        basePrepare.adapter = {
          ...basePrepare.adapter,
          deploy: async context => {
            await originalDeploy(context);
            await startServer(commit);
          },
        };
        const plan = await buildPlan(basePrepare);
        await applyInstall(basePrepare, plan);
        redeployGhCalls = redeploy.allCommandLines().filter(line => line.startsWith('gh '));
      },
      health: async commit => {
        const response = await fetch(`${url}/healthz`);
        const body = await response.json() as { ok?: boolean; commit?: string };
        if (!response.ok || !body.ok || body.commit !== commit) {
          throw new Error(`/healthz answered ${response.status} for ${body.commit ?? 'unknown'}`);
        }
      },
      pin: async () => {},
      prune: async () => {},
      schema: async () => 1,
      database: async () => 1,
    };

    const watchLogs: string[] = [];
    await watchMain(deployFile, ports, { intervalMs: 100, once: true, log: line => watchLogs.push(line) });
    assert.equal(readDeployRecord(deployFile)?.tip, commitB, `deploy watch recorded the new verified commit as served (record=${JSON.stringify(readDeployRecord(deployFile))}, logs=${watchLogs.join(' | ')})`);
    assert.equal(readDeployRecord(deployFile)?.reason, null);
    assert.deepEqual(redeployGhCalls, [], 'no gh command ran during the deploy watch restart');

    const health = await (await fetch(`${url}/healthz`)).json() as { ok: boolean; commit: string };
    assert.equal(health.ok, true);
    assert.equal(health.commit, commitB, 'the newly verified commit reached the control plane /healthz without a gh login');
  } finally {
    const running = server as ChildProcess | null;
    if (running && running.exitCode === null) await new Promise(resolve => { running.once('exit', resolve); running.kill(); });
    await initial.cleanup();
    await cluster.stop();
  }
});
