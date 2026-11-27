import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { listen } from './helpers/http-server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4003: a worker launched while the server is mid-deploy sees a different commit at /healthz.
// The launcher keeps retrying the release handover with backoff for up to a minute and runs the
// command once the matching release is served, instead of giving up after 1.5 seconds.

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const checkout = fileURLToPath(new URL('..', import.meta.url));

test('integration:launch-waits-for-handover — a CLI launched while the server serves another commit for 5 seconds runs once the matching commit is served; a mismatch that outlasts the window exits naming it', async t => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
  const other = 'f'.repeat(40);
  const cwd = await temporaryDirectory('launch-waits-cwd');
  let served = other;
  const api: string[] = [];
  const { url } = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/healthz') return response.end(JSON.stringify({ ok: true, version: '0.0.0-dev', commit: served }));
    api.push(`${request.method} ${request.url}`);
    return response.end(JSON.stringify({ key: 'GY-1', commit: served }));
  }, t);
  // Only this test's settings: a worker session's own GRAPHYARD_*/MAINWORKS_* would point elsewhere.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GRAPHYARD|MAINWORKS)_/.test(name))), GRAPHYARD_TOKEN: 'test-only', GRAPHYARD_URL: url };

  const started = Date.now();
  const switched = setTimeout(() => { served = head; }, 5_000);
  const launched = await exec(process.execPath, [launcher, 'status', 'GY-1'], { cwd, env });
  clearTimeout(switched);
  assert.ok(Date.now() - started >= 5_000, 'the launch waited through the deploy');
  assert.equal(JSON.parse(launched.stdout).commit, head, 'the command ran against the matching release');
  assert.match(launched.stderr, /release handover: retry/);
  assert.deepEqual(api, ['GET /api/work/GY-1'], 'no API request went out while the commits differed');

  // A mismatch that never clears still ends, with the difference named (window shortened for the test).
  served = other; api.length = 0;
  const refused = await exec(process.execPath, [launcher, 'status', 'GY-1'], { cwd, env: { ...env, GRAPHYARD_RELEASE_HANDOVER_MS: '2000' } }).then(() => null, (error: any) => error);
  assert.equal(refused?.code, 1);
  assert.match(refused?.stderr ?? '', new RegExp(`CLI commit ${head} and server commit ${other} differ`));
  assert.match(refused?.stderr ?? '', /still serves another commit after 2s; giving up/);
  assert.deepEqual(api, []);
});
