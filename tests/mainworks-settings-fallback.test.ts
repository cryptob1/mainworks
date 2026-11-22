import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { ensureTokens, installDirectory, tokenFile, Vault } from '../src/install/secrets.js';
import { deployUnitOf, perInstallUnits, readInstallUnits, recordInstallUnits } from '../src/install/units.js';
import { setupRepository } from '../src/repository-setup.js';
import { guideList, guideTopics } from '../src/guide.js';
import { masterGuide } from '../src/master/guide.js';

// GY-3573: Graphyard is now Mainworks. Every setting reads MAINWORKS_X before GRAPHYARD_X, a fresh
// install uses the mainworks paths and unit names, and an existing install keeps its graphyard ones.

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repository, 'bin', 'graphyard.mjs');
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const token = (tag: string) => tag.repeat(40);

/** Every path under DIRECTORY, relative, sorted: the layout a command must leave untouched. */
async function layout(directory: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    out.push(path);
    if (entry.isDirectory() && entry.name !== '.git') out.push(...await layout(join(directory, entry.name), path));
  }
  return out.sort();
}

/** Lines naming a Graphyard setting, path or unit, other than the one line saying they are still honoured. */
const oldNames = (text: string) => text.split('\n').filter(line => /GRAPHYARD_|\.graphyard\/|\.config\/graphyard|graphyard-(master|executor|deploy)-/.test(line) && !/still honoured/.test(line));

test('e2e:mainworks-settings-fallback — MAINWORKS_* settings win over GRAPHYARD_*, a fresh install gets only mainworks paths and units, an old install keeps its graphyard layout, and the docs name only the new names', async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(String(request.headers.authorization));
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true }));
    if (request.url === '/api/work/GY-1') return response.end(JSON.stringify({ id: 'work-1', key: 'GY-1', epoch: 1, stage: 'build' }));
    response.statusCode = 404; response.end(JSON.stringify({ error: 'Not found' }));
  });
  await listen(server);
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const base = await temporaryDirectory('mainworks-names');
  const savedHome = process.env.HOME;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GRAPHYARD|MAINWORKS)_/.test(name)));
  const status = (cwd: string, home: string, env: Record<string, string>) =>
    exec(process.execPath, [cli, 'status', 'GY-1', '--json'], { cwd, env: { ...clean, HOME: home, ...env } })
      .then(r => ({ code: 0, ...r }), (error: any) => ({ code: error.code as number, stdout: String(error.stdout), stderr: String(error.stderr) }));
  try {
    // AC-1: only MAINWORKS_URL, then only GRAPHYARD_URL, reach the same control plane; with both, the new name wins.
    const outside = join(base, 'outside'); await mkdir(outside);
    const bare = join(base, 'bare-home'); await mkdir(bare);
    const byNew = await status(outside, bare, { MAINWORKS_URL: url, MAINWORKS_TOKEN: token('m') });
    assert.equal(byNew.code, 0, `status with only MAINWORKS_URL succeeds: ${byNew.stderr}`);
    const byOld = await status(outside, bare, { GRAPHYARD_URL: url, GRAPHYARD_TOKEN: token('g') });
    assert.equal(byOld.code, 0, `status with only GRAPHYARD_URL succeeds: ${byOld.stderr}`);
    assert.deepEqual(JSON.parse(byNew.stdout), JSON.parse(byOld.stdout));
    assert.ok(seen.includes(`Bearer ${token('m')}`) && seen.includes(`Bearer ${token('g')}`), 'both runs reached the same control plane');
    const both = await status(outside, bare, { MAINWORKS_URL: url, GRAPHYARD_URL: 'http://127.0.0.1:9', MAINWORKS_TOKEN: token('b'), GRAPHYARD_TOKEN: token('x') });
    assert.equal(both.code, 0, `the MAINWORKS_ names win when both are set: ${both.stderr}`);
    assert.ok(seen.includes(`Bearer ${token('b')}`) && !seen.includes(`Bearer ${token('x')}`));

    // AC-2, fresh: the install directory, the checkout's state directory and the units take the mainworks names only.
    const fresh = join(base, 'fresh-home'); await mkdir(fresh);
    process.env.HOME = fresh;
    const directory = installDirectory('owner-project');
    assert.equal(directory, join(fresh, '.config', 'mainworks', 'owner-project'));
    await mkdir(join(directory, 'tokens'), { recursive: true, mode: 0o700 });
    await ensureTokens(directory, [{ id: 'worker-1', role: 'worker' }], new Vault());
    assert.equal((await stat(tokenFile(directory, 'worker-1'))).mode & 0o777, 0o600, 'install credentials are mode 0600');
    const project = join(base, 'fresh-project'); await mkdir(project);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    await setupRepository(project, { url, cliPath: cli, hostId: 'host-a' });
    assert.equal((await stat(join(project, '.mainworks', 'connection.json'))).mode & 0o777, 0o600);
    const units = await recordInstallUnits(project, perInstallUnits('owner/project'));
    assert.deepEqual([units.master, units.executorTemplate, deployUnitOf(units)], ['mainworks-master-owner-project.service', 'mainworks-executor-owner-project@.service', 'mainworks-deploy-owner-project.service']);
    assert.ok(existsSync(join(project, '.mainworks', 'units.json')));
    assert.match(await readFile(join(project, '.gitignore'), 'utf8'), /^\.mainworks\/$/m);
    const freshRun = await status(project, fresh, { MAINWORKS_TOKEN: token('f') });
    assert.equal(freshRun.code, 0, `status from the fresh checkout succeeds: ${freshRun.stderr}`);
    assert.ok(seen.includes(`Bearer ${token('f')}`));
    assert.ok(!existsSync(join(project, '.graphyard')) && !existsSync(join(fresh, '.config', 'graphyard')), 'a fresh install gets only the new names');

    // AC-2, existing: a home and checkout with the graphyard layout keep it, and status still runs.
    const old = join(base, 'old-home'), oldProject = join(base, 'old-project');
    await mkdir(join(old, '.config', 'graphyard', 'owner-project'), { recursive: true });
    await writeFile(join(old, '.config', 'graphyard', 'owner-project', 'install.json'), '{}', { mode: 0o600 });
    await mkdir(join(oldProject, '.graphyard'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: oldProject });
    await writeFile(join(oldProject, '.graphyard', 'connection.json'), JSON.stringify({ url, cliPath: cli, hostId: 'host-a', token: token('o') }), { mode: 0o600 });
    await writeFile(join(oldProject, '.graphyard', 'units.json'), JSON.stringify({ version: 1, slug: 'owner-project', master: 'graphyard-master-owner-project.service', executorTemplate: 'graphyard-executor-owner-project@.service', alias: false }));
    const before = [...await layout(old), '|', ...await layout(oldProject)];
    const oldRun = await status(oldProject, old, {});
    assert.equal(oldRun.code, 0, `status from the old layout succeeds: ${oldRun.stderr}`);
    assert.ok(seen.includes(`Bearer ${token('o')}`), 'the old connection file was used');
    assert.deepEqual([...await layout(old), '|', ...await layout(oldProject)], before, 'nothing moved or added');
    process.env.HOME = old;
    assert.equal(installDirectory('owner-project'), join(old, '.config', 'graphyard', 'owner-project'));
    const oldUnits = readInstallUnits(oldProject, join(base, 'units'), old);
    assert.equal(deployUnitOf(oldUnits), 'graphyard-deploy-owner-project.service');

    // AC-3: README and the CLI guide name only the new settings and paths, with one line saying the old ones are honoured.
    const readme = await readFile(join(repository, 'README.md'), 'utf8');
    const guide = [guideList(), ...Object.values(guideTopics), masterGuide].join('\n');
    for (const [name, text] of [['README.md', readme], ['the CLI guide', guide]] as const) {
      assert.deepEqual(oldNames(text), [], `${name} names only the Mainworks settings and paths`);
      assert.match(text, /MAINWORKS_/);
      assert.match(text, /\.mainworks\//);
      assert.equal(text.split('\n').filter(line => /still honoured/.test(line)).length, 1, `${name} says once that the Graphyard names are still honoured`);
    }
  } finally {
    process.env.HOME = savedHome;
    await close(server);
  }
});
