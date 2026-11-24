import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { chooseInstallLayout } from '../src/install/layout.js';
import { ensureTokens, installDirectory, plannedPrincipals, prepareInstallDirectory, Vault } from '../src/install/secrets.js';
import { installLoopSupervisor } from '../src/install/loop-unit.js';
import { localDirectory } from '../src/onboarding.js';
import { stateDirectory } from '../src/install/layout.js';

// GY-3711: a fresh install takes the Mainworks names (~/.config/mainworks, .mainworks, mainworks-*
// units); an install that already has the legacy ones keeps them, with nothing moved.

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repository, 'bin', 'graphyard.mjs');
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const REPOSITORY = 'owner/project', INSTALL = 'owner-project';

/** Every path under DIRECTORY, relative to it, with its mode; git's own objects left out. */
async function tree(directory: string) {
  const entries = (await readdir(directory, { recursive: true })).filter(path => !path.split('/').includes('.git')).sort();
  return Promise.all(entries.map(async path => `${path} ${((await stat(join(directory, path))).mode & 0o777).toString(8)}`));
}
const named = (paths: string[], word: string) => paths.filter(path => path.split(' ')[0]!.split('/').some(part => part.includes(word)));

test('e2e:mainworks-install-layout — a fresh home gets only the Mainworks names; a home with the legacy layout keeps it, nothing moved, and status still runs', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true }));
    if (request.url === '/api/work/GY-1') return response.end(JSON.stringify({ id: 'work-1', key: 'GY-1', epoch: 1, stage: 'build' }));
    response.statusCode = 404; response.end(JSON.stringify({ error: 'Not found' }));
  });
  await listen(server);
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const savedHome = process.env.HOME;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GRAPHYARD|MAINWORKS)_/.test(name)));
  for (const name of Object.keys(process.env)) if (/^(GRAPHYARD|MAINWORKS)_CONFIG_HOME$/.test(name)) delete process.env[name];
  const status = (cwd: string, home: string) => exec(process.execPath, [cli, 'status', 'GY-1', '--json'], { cwd, env: { ...clean, HOME: home, XDG_CONFIG_HOME: join(home, '.config') } })
    .then(r => ({ code: 0, ...r }), (error: any) => ({ code: error.code as number, stdout: String(error.stdout), stderr: String(error.stderr) }));
  const connection = (token: string) => JSON.stringify({ url, cliPath: cli, hostId: 'layout-host', token: token.repeat(40) });
  const host = (home: string) => ({ home, temporaryDirectories: [join(home, 'volatile')], run: () => '' });

  /** One install into ROOT under HOME: the install-time choice, then the real writers of each name. */
  async function install(root: string, home: string) {
    process.env.HOME = home;
    chooseInstallLayout(root, home);
    const directory = await prepareInstallDirectory(installDirectory(INSTALL), root);
    const vault = new Vault(), principals = plannedPrincipals(INSTALL);
    await ensureTokens(directory, principals, vault);
    const local = await localDirectory(root);
    if (!(await stat(join(local, 'connection.json')).catch(() => null))) await writeFile(join(local, 'connection.json'), connection('f'), { mode: 0o600 });
    await writeFile(join(stateDirectory(root), 'master.json'), JSON.stringify({ repository: REPOSITORY }), { mode: 0o600 });
    const units = await installLoopSupervisor({ root, cliPath: cli, repository: REPOSITORY, intervalSeconds: 20, execPath: process.execPath, installDir: directory }, host(home));
    assert.equal(units.refused, null, `the units install: ${units.reason}`);
    return directory;
  }

  try {
    // A fresh home and checkout: only the new names.
    const base = await temporaryDirectory('mainworks-layout');
    const freshHome = join(base, 'fresh-home'), freshRoot = join(base, 'fresh-home', 'code', 'project');
    await mkdir(freshRoot, { recursive: true });
    execFileSync('git', ['init', '-q', freshRoot]);
    const directory = await install(freshRoot, freshHome);
    assert.equal(directory, join(freshHome, '.config', 'mainworks', INSTALL), 'the install directory is under ~/.config/mainworks');
    const files = await tree(freshHome);
    const installFiles = files.filter(entry => entry.startsWith(`.config/mainworks/${INSTALL}/`) && !entry.endsWith(' 700'));
    assert.ok(installFiles.length >= 2, `the install wrote its files: ${installFiles.join(', ')}`);
    for (const entry of installFiles) assert.match(entry, / 600$/, `install files are mode 0600: ${entry}`);
    assert.ok(files.some(entry => entry.startsWith('code/project/.mainworks/units.json ')), 'the checkout has a .mainworks directory recording its units');
    assert.ok(files.some(entry => entry.startsWith('code/project/.mainworks/connection.json 600')), 'local credentials live in .mainworks');
    const units = (await readdir(join(freshHome, '.config', 'systemd', 'user'))).sort();
    assert.deepEqual(units, [`mainworks-deploy-${INSTALL}.service`, `mainworks-master-${INSTALL}.service`], 'the units are named mainworks-*');
    assert.match(await readFile(join(freshRoot, '.gitignore'), 'utf8'), /^\.mainworks\/$/m, 'Git ignores .mainworks');
    const freshStatus = await status(freshRoot, freshHome);
    assert.equal(freshStatus.code, 0, `status runs in the fresh install: ${freshStatus.stderr}`);
    assert.deepEqual(named(await tree(freshHome), 'graphyard'), [], 'nothing in the fresh home uses the old name');

    // A home seeded with the legacy layout: kept as it is, and status runs from it.
    const oldHome = join(base, 'old-home'), oldRoot = join(oldHome, 'code', 'project');
    await mkdir(join(oldHome, '.config', 'graphyard', INSTALL, 'tokens'), { recursive: true, mode: 0o700 });
    await mkdir(join(oldRoot, '.graphyard'), { recursive: true });
    execFileSync('git', ['init', '-q', oldRoot]);
    await writeFile(join(oldRoot, '.gitignore'), '.graphyard/\n');
    await writeFile(join(oldRoot, '.graphyard', 'connection.json'), connection('o'), { mode: 0o600 });
    await writeFile(join(oldRoot, '.graphyard', 'units.json'), `${JSON.stringify({ version: 1, slug: INSTALL, master: `graphyard-master-${INSTALL}.service`, executorTemplate: `graphyard-executor-${INSTALL}@.service`, alias: false }, null, 2)}\n`, { mode: 0o600 });
    const before = await tree(oldHome);
    const oldStatus = await status(oldRoot, oldHome);
    assert.equal(oldStatus.code, 0, `status runs in the legacy layout: ${oldStatus.stderr}`);
    assert.deepEqual(JSON.parse(oldStatus.stdout).key, 'GY-1');
    // The upgrade re-runs the install steps: every name stays the legacy one.
    const oldDirectory = await install(oldRoot, oldHome);
    assert.equal(oldDirectory, join(oldHome, '.config', 'graphyard', INSTALL));
    const after = await tree(oldHome);
    assert.deepEqual(named(after, 'mainworks'), [], 'nothing in the existing home is named mainworks');
    for (const entry of before) assert.ok(after.includes(entry), `${entry} is still where it was`);
    assert.deepEqual((await readdir(join(oldHome, '.config', 'systemd', 'user'))).sort(), [`graphyard-deploy-${INSTALL}.service`, `graphyard-master-${INSTALL}.service`], 'the units keep their graphyard-* names');
    const again = await status(oldRoot, oldHome);
    assert.equal(again.code, 0, `status still runs after the upgrade: ${again.stderr}`);
    assert.ok(relative(oldHome, oldDirectory).startsWith('.config/graphyard'));
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    await close(server);
  }
});
