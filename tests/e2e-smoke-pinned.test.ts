// GY-4052: e2e:smoke's take-turns step failed on main and passed on its re-run. The test took the host's
// real image lock, so whenever another process held it — a real deploy, a trial image build, or the
// bad-blob test running beside it in the same smoke step — both fixture installs waited on that holder and
// either could build first. This test injects that one condition: another install holds the image lock
// under the lock root the test inherits, until the second fixture install reports it is waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { controlPlaneRecordPath, readControlPlaneRecord } from '../src/deploy-watch.js';
import { imageLock, withHostLock } from '../src/host-lock.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const file = fileURLToPath(new URL('./two-installs-deploy-builds-take-turns.test.ts', import.meta.url));

test('unit:e2e-smoke-pinned — the take-turns step passes while another install holds the host image lock', { timeout: 90_000 }, async () => {
  const [locks, scratch] = await Promise.all([temporaryDirectory('smoke-pinned-locks'), temporaryDirectory('smoke-pinned-tmp')]);
  const saved = process.env.MAINWORKS_LOCK_ROOT;
  process.env.MAINWORKS_LOCK_ROOT = locks;
  try {
    const { NODE_TEST_CONTEXT: _, ...environment } = process.env;
    let output = '';
    let exited!: Promise<number | null>;
    await withHostLock(imageLock, async () => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern=start one second apart', file], {
        env: { ...environment, TMPDIR: scratch }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      exited = new Promise<number | null>(resolve => child.once('exit', resolve));
      let done = false;
      void exited.then(() => { done = true; });
      const huckWaits = () => readdirSync(scratch).some(name => name.includes('take-turns-huck-') && !!readControlPlaneRecord(controlPlaneRecordPath(join(scratch, name)))?.waiting);
      while (!done && !huckWaits()) await delay(50);
    }, { holder: 'another install' });
    assert.equal(await exited, 0, output);
  } finally {
    if (saved === undefined) delete process.env.MAINWORKS_LOCK_ROOT; else process.env.MAINWORKS_LOCK_ROOT = saved;
  }
});
