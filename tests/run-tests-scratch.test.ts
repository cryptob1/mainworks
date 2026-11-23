import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3691: a test run removes the scratch root it created when it ends — pass, fail or SIGTERM —
// unless GRAPHYARD_KEEP_SCRATCH asks to keep it. Leftover runs filled the host's disk.

/** A fixture suite: one file that writes 5 MB under its tmpdir, then passes, fails or waits to be killed. */
async function fixture(outcome: 'pass' | 'fail' | 'hang') {
  const project = await temporaryDirectory('scratch-fixture');
  await mkdir(join(project, 'tests'));
  await writeFile(join(project, 'tests', 'scratch.test.mjs'), `
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('writes scratch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'leftover-'));
  for (let at = 0; at < 5; at++) writeFileSync(join(directory, 'blob-' + at), Buffer.alloc(1024 * 1024, 1));
  writeFileSync(join(${JSON.stringify(project)}, 'written'), directory);
  if (${JSON.stringify(outcome)} === 'fail') throw new Error('the fixture fails');
  if (${JSON.stringify(outcome)} === 'hang') await new Promise(() => setInterval(() => {}, 1000));
});
`);
  return project;
}

async function run(outcome: 'pass' | 'fail' | 'hang', keep = false) {
  const project = await fixture(outcome), scratch = await temporaryDirectory('scratch-parent');
  const environment: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_KEEP_SCRATCH: keep ? '1' : '' };
  const running = runTests({ cwd: project, args: ['tests/scratch.test.mjs'], stdio: 'pipe', environment, scratch });
  if (outcome === 'hang') {
    while (!existsSync(join(project, 'written'))) await new Promise(done => setTimeout(done, 50));
    process.kill(process.pid, 'SIGTERM');
  }
  const { code, stdout, stderr } = await running;
  return { code, output: stdout + stderr, scratch, written: existsSync(join(project, 'written')) };
}

test('unit:test-scratch-is-removed-when-the-run-ends — a passing, failing or SIGTERM-ended run leaves its scratch parent empty; GRAPHYARD_KEEP_SCRATCH keeps it', async () => {
  const passed = await run('pass');
  assert.equal(passed.code, 0, passed.output);
  assert.ok(passed.written, 'the fixture wrote its 5 MB');
  assert.deepEqual(await readdir(passed.scratch), [], 'a passing run removes its scratch root');

  const failed = await run('fail');
  assert.notEqual(failed.code, 0, failed.output);
  assert.ok(failed.written);
  assert.deepEqual(await readdir(failed.scratch), [], 'a failing run removes its scratch root');

  const stopped = await run('hang');
  assert.notEqual(stopped.code, 0, stopped.output);
  assert.deepEqual(await readdir(stopped.scratch), [], 'a run ended by SIGTERM removes its scratch root');

  const kept = await run('pass', true);
  assert.equal(kept.code, 0, kept.output);
  const roots = await readdir(kept.scratch);
  assert.equal(roots.length, 1, `GRAPHYARD_KEEP_SCRATCH keeps the run's scratch root and nothing beside it: ${roots}`);
  assert.ok((await readdir(join(kept.scratch, roots[0]!), { recursive: true })).some(name => name.includes('blob-')), 'with the fixture\'s files in it');
});
