import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { setting } from '../src/setting.js';

// GY-3573: Graphyard is now Mainworks. Every setting reads MAINWORKS_X before GRAPHYARD_X through one helper.

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repository, 'bin', 'graphyard.mjs');
const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const token = (tag: string) => tag.repeat(40);

test('e2e:mainworks-settings-fallback — only MAINWORKS_URL and only GRAPHYARD_URL reach the same control plane, the new name winning when both are set', async () => {
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
  const base = await temporaryDirectory('mainworks-settings');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GRAPHYARD|MAINWORKS)_/.test(name)));
  const outside = join(base, 'outside'), home = join(base, 'home');
  await mkdir(outside); await mkdir(home);
  const status = (cwd: string, env: Record<string, string>) =>
    exec(process.execPath, [cli, 'status', 'GY-1', '--json'], { cwd, env: { ...clean, HOME: home, ...env } })
      .then(r => ({ code: 0, ...r }), (error: any) => ({ code: error.code as number, stdout: String(error.stdout), stderr: String(error.stderr) }));
  try {
    const byNew = await status(outside, { MAINWORKS_URL: url, MAINWORKS_TOKEN: token('m') });
    assert.equal(byNew.code, 0, `status with only MAINWORKS_URL succeeds: ${byNew.stderr}`);
    const byOld = await status(outside, { GRAPHYARD_URL: url, GRAPHYARD_TOKEN: token('g') });
    assert.equal(byOld.code, 0, `status with only GRAPHYARD_URL succeeds: ${byOld.stderr}`);
    assert.deepEqual(JSON.parse(byNew.stdout), JSON.parse(byOld.stdout));
    assert.ok(seen.includes(`Bearer ${token('m')}`) && seen.includes(`Bearer ${token('g')}`), 'both runs reached the same control plane');

    const both = await status(outside, { MAINWORKS_URL: url, GRAPHYARD_URL: 'http://127.0.0.1:9', MAINWORKS_TOKEN: token('b'), GRAPHYARD_TOKEN: token('x') });
    assert.equal(both.code, 0, `the MAINWORKS_ names win when both are set: ${both.stderr}`);
    assert.ok(seen.includes(`Bearer ${token('b')}`) && !seen.includes(`Bearer ${token('x')}`));

    // MAINWORKS_* settings that arrive through the checkout's .env are honoured too.
    const dotenv = join(base, 'dotenv'); await mkdir(dotenv);
    await writeFile(join(dotenv, '.env'), `MAINWORKS_URL=${url}\nMAINWORKS_TOKEN=${token('e')}\n`);
    const byEnvFile = await status(dotenv, {});
    assert.equal(byEnvFile.code, 0, `status with MAINWORKS_URL only in .env succeeds: ${byEnvFile.stderr}`);
    assert.ok(seen.includes(`Bearer ${token('e')}`), 'the .env MAINWORKS_TOKEN reached the control plane');

    // The one helper: the new name first, either prefix accepted, the environment only read.
    const env = { MAINWORKS_PROBE: 'new', GRAPHYARD_PROBE: 'old', GRAPHYARD_ONLY: 'old' };
    assert.equal(setting('PROBE', env), 'new');
    assert.equal(setting('GRAPHYARD_PROBE', env), 'new');
    assert.equal(setting('ONLY', env), 'old');
    assert.deepEqual(env, { MAINWORKS_PROBE: 'new', GRAPHYARD_PROBE: 'old', GRAPHYARD_ONLY: 'old' });
  } finally {
    await close(server);
  }
});
