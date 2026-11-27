// GY-3123: the deploy watch runs its newly deployed code. A watch process that serves a commit
// whose code it is not running hands itself over — the invocation ends with the release handover,
// the launcher reloads the pointer the checkout published and restarts the watch on that code — so
// a rule the new code enforces (the batch gate's serve-only-verified) is in force from the next
// pass, and the deploy the handover follows neither rolls back nor runs again in the successor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { bootstrapGate, gateRecordPath, writeGateRecord } from '../src/batch-gate.js';
import { controlPlaneRecordPath, deployRecordPath, readControlPlaneRecord, readDeployRecord } from '../src/deploy-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { listen } from './helpers/http-server.js';
import { until } from './helpers/until.js';
import { git } from './helpers/git-repo.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const modules = resolve(createRequire(import.meta.url).resolve('tsx'), '../../..');
const repository = 'owner/project';
const watchIntervalMs = 200;

// Bundle src/cli.ts into dist/cli.mjs (matching bin/built-entry.mjs) so fixture watch and install
// invocations start from the compiled entry instead of recompiling ~550 TS files via tsx on each spawn.
async function buildFixtureCli(root: string): Promise<Uint8Array> {
  const entry = join(root, 'src', 'cli.ts'), dist = join(root, 'dist'), outfile = join(dist, 'cli.mjs');
  const { outputFiles } = await esbuild({
    entryPoints: [entry], outfile, write: false, bundle: true, platform: 'node', format: 'esm',
    target: 'node24', packages: 'external', minify: false, logLevel: 'warning', absWorkingDir: root,
    banner: { js: `import { pathToFileURL as __bundleUrlOf } from 'node:url'; const __bundleUrl = process.argv[1] && process.argv[1].endsWith('/dist/cli.mjs') ? __bundleUrlOf(process.argv[1]).href : import.meta.url;` },
    define: { 'import.meta.url': '__moduleUrl' },
    plugins: [{
      name: 'source-import-meta-url',
      setup(context) {
        context.onLoad({ filter: /\.(tsx?|m?js)$/ }, async ({ path }) => {
          const text = await readFile(path, 'utf8');
          const prefix = path === entry || text.includes('import.meta.url')
            ? `const __moduleUrl = ${path === entry ? '__bundleUrl' : `new URL(${JSON.stringify(relative(dist, path).split('\\').join('/'))}, __bundleUrl).href`};\n`
            : '';
          return { contents: `${prefix}${text}`, loader: path.endsWith('x') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' };
        });
      },
    }],
  });
  await mkdir(dist, { recursive: true });
  await writeFile(outfile, outputFiles[0].contents);
  return outputFiles[0].contents;
}

// Each fixture tree owns its tsx; the other dependencies are shared, as worker checkouts share them.
async function dependencies(root: string) {
  const target = join(root, 'node_modules');
  await mkdir(target, { recursive: true });
  await Promise.all((await readdir(modules)).map(name =>
    name === 'tsx' ? cp(join(modules, name), join(target, name), { recursive: true }) : symlink(join(modules, name), join(target, name)),
  ));
}

test('integration:deploy-watch-runs-deployed-code — a watch that deploys a commit changing the deploy-watch code hands over to it without losing the deploy, and the handed-over watch serves only the latest gate-verified commit, never an unverified main tip', { timeout: 300_000 }, async () => {
  const base = await temporaryDirectory('deploy-watch-runs-deployed-code');
  const configHome = join(base, 'config'), shim = join(base, 'shim'), state = join(base, 'state');
  const checkout = join(base, 'checkout'), install = join(configHome, 'owner-project');
  const launcherRoot = join(install, 'deploy', 'build'), deploySrc = join(install, 'deploy', 'src');
  await mkdir(state, { recursive: true });

  // The repository the watch serves: this source as a fixture checkout whose origin is local but
  // configured as github.com/owner/project, so the record and the gate name the repository.
  await mkdir(checkout);
  await Promise.all([
    ...['src', 'bin', 'scripts', 'docs', 'e2e', 'fixtures'].map(name => cp(join(source, name), join(checkout, name), { recursive: true })),
    ...['package.json', 'package-lock.json', 'graphyard.json', 'README.md'].map(name => cp(join(source, name), join(checkout, name))),
  ]);
  const upgradeSource = await readFile(join(checkout, 'src', 'cli', 'upgrade.ts'), 'utf8');
  const fastWatch = upgradeSource
    .replace('const intervalMs = master.run.intervalSeconds * 1000', `const intervalMs = ${watchIntervalMs}`)
    .replace(
      `const invoke = (flags: string[]) => run(process.execPath, ['--import', loader, join(build, 'src', 'cli.ts'), 'install', ...flags]`,
      `const invoke = (flags: string[]) => run(process.execPath, [existsSync(join(build, 'dist', 'cli.mjs')) ? join(build, 'dist', 'cli.mjs') : '--import', ...(existsSync(join(build, 'dist', 'cli.mjs')) ? [] : [loader, join(build, 'src', 'cli.ts')]), 'install', ...flags]`,
    );
  assert.notEqual(fastWatch, upgradeSource, 'the fixture sets a fast watch interval');
  assert.ok(fastWatch.includes("join(build, 'dist', 'cli.mjs')"), 'the fixture invokes the built CLI for install');
  await writeFile(join(checkout, 'src', 'cli', 'upgrade.ts'), fastWatch);
  await writeFile(join(checkout, '.gitignore'), 'node_modules/\n.graphyard/\n');
  git(checkout, 'init', '-q', '-b', 'main', '.'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'A');
  const a = git(checkout, 'rev-parse', 'HEAD');
  const origin = join(base, 'origin.git'); git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'config', `url.${origin}.insteadOf`, `https://github.com/${repository}`);
  git(checkout, 'remote', 'set-url', 'origin', `https://github.com/${repository}`);
  git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  await dependencies(checkout);

  // A health endpoint that always reports the commit the docker shim last built an image for.
  const { port: serverPort, close } = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/healthz')) {
      let served = 'f'.repeat(40);
      try { served = (readFileSync(join(state, 'deployed'), 'utf8').trim() || served).padEnd(40, '0'); } catch { /* nothing deployed yet */ }
      response.end(JSON.stringify({ ok: true, healthy: true, version: `unreleased ${served.slice(0, 12)}`, commit: served, schema: 0 }));
    } else response.end(JSON.stringify({ actor: { id: 'operator', role: 'admin' }, repository }));
  });
  const port = serverPort, url = `http://127.0.0.1:${port}`;

  // The only Docker and gh this fixture has: every provider command succeeds but a pull (GY-3214:
  // these commits are published nowhere, so the install builds them) and an image inspect (GY-3710:
  // no commit's image is on this host beforehand), `compose ps` reports the
  // deployment running, and an image build records its per-commit tag as the served commit.
  await mkdir(shim, { recursive: true });
  await writeFile(join(shim, 'docker'), `#!/bin/sh
echo "docker \$*" >> ${JSON.stringify(join(state, 'docker.log'))}
[ "\$1 \$2" = "image pull" ] && exit 1
[ "\$1 \$2" = "image inspect" ] && exit 1
for arg in "$@"; do
  if [ "$prev" = "--tag" ]; then
    tag=\$(echo "\$arg" | sed 's|.*:||')
    case "\$tag" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) printf %s "\$tag" > ${JSON.stringify(join(state, 'deployed'))};; esac
  fi
  prev="\$arg"
done
case " \$* " in *" ps --format json"*) echo '{"Service":"db","State":"running"}'; echo '{"Service":"server","State":"running"}';; esac
exit 0\n`, { mode: 0o755 });
  await writeFile(join(shim, 'gh'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

  // A recorded compose installation on the fixture's port, as a first apply leaves it.
  await mkdir(join(install, 'compose'), { recursive: true });
  await writeFile(join(install, 'compose', 'compose.yaml'), `name: graphyard-owner-project\nservices:\n  server:\n    ports: ["127.0.0.1:${port}:4310"]\n`);
  await writeFile(join(install, 'install.json'), `${JSON.stringify({ version: 1, installId: 'owner-project', repository, provider: 'compose', baseBranch: 'main', url,
    deployment: { local: false, port, image: 'mainworks-local:owner-project' }, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }, null, 2)}\n`);
  await writeFile(join(base, 'master.token'), 'fixture-master-token-0123456789abcdef\n', { mode: 0o600 });
  await mkdir(join(checkout, '.graphyard'), { recursive: true });
  await writeFile(join(checkout, '.graphyard', 'master.json'), `${JSON.stringify({ version: 1, url, credentialFile: join(base, 'master.token'), cliPath: join(launcherRoot, 'bin', 'graphyard.mjs'),
    repository, baseBranch: 'main', hostId: 'fixture-host', masterAgentName: 'graphyard-master', run: { intervalSeconds: 5 } }, null, 2)}\n`, { mode: 0o600 });
  await writeGateRecord(gateRecordPath(checkout), bootstrapGate(repository, a));

  git(checkout, 'worktree', 'add', '--detach', '--quiet', launcherRoot, a);
  await dependencies(launcherRoot);
  await buildFixtureCli(launcherRoot);

  const watch = { out: '', err: '' };
  // The watch gets the environment the unit gives it: no Mainworks variables of the enclosing run.
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GRAPHYARD_') && !name.startsWith('HERDR_') && value !== undefined) clean[name] = value;
  const child = spawn(process.execPath, [join(launcherRoot, 'bin', 'graphyard.mjs'), 'upgrade', '--watch', '--checkout', deploySrc], {
    cwd: checkout, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...clean, PATH: `${shim}:${clean.PATH}`, GRAPHYARD_CONFIG_HOME: configHome, GRAPHYARD_REPOSITORY_ROOT: checkout, GRAPHYARD_VERIFICATION_SLOTS_DIR: join(base, 'heavy-jobs'), XDG_DATA_HOME: join(base, 'data'), NODE_TEST_CONTEXT: '1' },
  });
  child.stdout!.on('data', data => { watch.out += data; }); child.stderr!.on('data', data => { watch.err += data; });

  const record = deployRecordPath(checkout);
  const controlRecord = controlPlaneRecordPath(checkout);
  const buildsOf = async (sha: string) => {
    try { return ((await readFile(join(state, 'docker.log'), 'utf8')).match(new RegExp(`--tag mainworks-local:${sha.slice(0, 12)}( |$)`, 'gm')) ?? []).length; } catch { return 0; }
  };
  const markers = () => (watch.err.match(/running the deployed watch code/g) ?? []).length;
  const handovers = () => (watch.err.match(/release handover: retry/g) ?? []).length;
  const servedTip = () => readDeployRecord(record)?.tip ?? null;
  const checkedAt = () => readControlPlaneRecord(controlRecord)?.checkedAt ?? null;
  /** The watch fetched `sha` as main's tip, and at least one more pass ran after that. */
  const passesBeyond = async (sha: string) => {
    await until(() => { try { return git(deploySrc, 'rev-parse', 'refs/remotes/origin/main') === sha; } catch { return false; } }, `main moved to ${sha.slice(0, 12)} in the deploy checkout`, 150_000, 50);
    const seen = checkedAt();
    await until(() => {
      const next = checkedAt();
      return next !== null && next !== seen;
    }, `a pass completed after main moved to ${sha.slice(0, 12)}`, 150_000, 50);
  };
  /** The release tree the watch's build step would create, prepared in advance so no install runs. */
  const seedRelease = async (sha: string, reuseBundle?: Uint8Array): Promise<Uint8Array> => {
    const release = join(launcherRoot, '.graphyard', 'cli-releases', sha);
    git(checkout, 'worktree', 'add', '--detach', '--quiet', release, sha);
    await dependencies(release);
    let bundle: Uint8Array;
    if (reuseBundle) {
      await mkdir(join(release, 'dist'), { recursive: true });
      await writeFile(join(release, 'dist', 'cli.mjs'), reuseBundle);
      bundle = reuseBundle;
    } else {
      bundle = await buildFixtureCli(release);
    }
    await mkdir(join(release, '.graphyard'), { recursive: true });
    await writeFile(join(release, '.graphyard', 'cli-ready'), sha);
    return bundle;
  };

  try {
    await until(() => existsSync(join(deploySrc, '.git')), 'the watch created its deploy checkout', 150_000, 50);
    // A commit that changes the deploy-watch code: every pass of the new code says so.
    const watchSource = await readFile(join(checkout, 'src', 'deploy-watch.ts'), 'utf8');
    const marked = watchSource.replace('  for (;;) {\n    let served', `  for (;;) {\n    log('[mainworks-deploy] running the deployed watch code');\n    let served`);
    assert.notEqual(marked, watchSource, 'the fixture marks the deploy-watch code');
    await writeFile(join(checkout, 'src', 'deploy-watch.ts'), marked);
    git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'B: the deploy-watch code changes');
    const b = git(checkout, 'rev-parse', 'HEAD');
    git(checkout, 'push', '-q', 'origin', 'HEAD:main');
    const bBundle = await seedRelease(b);

    // While the gate pins A, B is only an unverified main tip: fetched, never served.
    await passesBeyond(b);
    await passesBeyond(b);
    assert.notEqual(servedTip(), b, 'an unverified main tip is never served');
    assert.equal(await buildsOf(b), 0, 'the unverified tip is never built');
    assert.equal(markers(), 0, 'the old watch code still runs');

    // The gate verifies B: the watch deploys it and hands itself over to its code.
    await writeGateRecord(gateRecordPath(checkout), bootstrapGate(repository, b));
    await until(() => servedTip() === b, 'B is served', 150_000, 50);
    await until(() => markers() > 0, 'the watch hands itself over to the new code', 150_000, 50);
    assert.ok(watch.err.includes('the watch hands itself over to'), 'the handover names what it does');
    await until(() => markers() > 1, 'a second pass runs on the new code', 150_000, 50);
    // The deploy the handover followed is neither lost nor redone: the record stands, one build.
    assert.equal(readDeployRecord(record)?.failed ?? null, null, 'nothing failed or rolled back');
    assert.equal(readDeployRecord(record)?.reason ?? null, null, 'the served tip is clean');
    assert.equal(await buildsOf(b), 1, 'the successor does not rebuild or redeploy the served commit');
    assert.ok(handovers() >= 1, 'the launcher reloaded the published pointer');

    // A newer unverified tip never serves; once verified, it does — and the watch follows it too.
    await writeFile(join(checkout, 'README.md'), `${await readFile(join(checkout, 'README.md'), 'utf8')}\nA later change.\n`);
    git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'C: a change that does not touch the watch');
    const c = git(checkout, 'rev-parse', 'HEAD');
    git(checkout, 'push', '-q', 'origin', 'HEAD:main');
    await seedRelease(c, bBundle);
    await passesBeyond(c);
    await passesBeyond(c);
    assert.equal(servedTip(), b, 'the handed-over watch still serves the verified commit only');
    assert.equal(await buildsOf(c), 0, 'the newer unverified tip is never built');
    await writeGateRecord(gateRecordPath(checkout), bootstrapGate(repository, c));
    await until(() => servedTip() === c, 'C is served', 150_000, 50);
    await until(() => handovers() >= 2, 'the watch follows the code it serves again', 150_000, 50);
    assert.equal(await buildsOf(c), 1, 'C is deployed exactly once');
  } finally {
    await close();
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([exited, new Promise(done => setTimeout(done, 1_000))]);
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await exited;
  }
});
