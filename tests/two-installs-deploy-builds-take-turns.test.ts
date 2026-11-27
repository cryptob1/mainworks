// GY-4030: two installs on one machine that update together take turns building and exporting their
// image under the host's real image lock, so neither build loses its BuildKit lease to the other.
import { readFileSync } from 'node:fs';
import { link, rm, writeFile } from 'node:fs/promises';
import { takeLock } from '../src/host-lock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { controlPlaneRecordPath, deployOnce, deployRecordPath, readControlPlaneRecord, readDeployRecord, type DeployWatchPorts } from '../src/deploy-watch.js';
import { deployPorts } from './helpers/deploy-ports.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40);

/** A fake builder whose export fails the way BuildKit does when another export runs beside it. */
function builder(exportMs: number) {
  let exporting = 0;
  const spans: { install: string; start: number; end: number }[] = [];
  const build = async (install: string) => {
    const start = Date.now();
    exporting++;
    try {
      await delay(exportMs);
      if (exporting > 1) throw new Error('failed to copy to tar: commit failed: lease does not exist: not found');
    } finally { exporting--; }
    spans.push({ install, start, end: Date.now() });
  };
  return { build, spans };
}

function install(name: string, root: string, restart: () => Promise<void>): DeployWatchPorts {
  let running = a;
  return deployPorts(b, a, {
    restart: async commit => { await restart(); running = commit; },
    health: async commit => { if (running !== commit) throw new Error(`serves ${running.slice(0, 12)}`); },
    lockFile: `${root}/deploy.lock`, install: name,
  });
}

test('integration:two-installs-deploy-builds-take-turns — two installs whose deploy builds start one second apart both serve the new commit, the second waiting for the first', { timeout: 60_000 }, async () => {
  const fake = builder(2500);
  const [coreRoot, huckRoot] = await Promise.all([temporaryDirectory('take-turns-core'), temporaryDirectory('take-turns-huck')]);
  const waits: string[] = [];
  const core = deployOnce(deployRecordPath(coreRoot), install('core', coreRoot, () => fake.build('core')), () => {}, null);
  await delay(1000);
  const huck = deployOnce(deployRecordPath(huckRoot), install('hello-huck-huck', huckRoot, async () => {
    assert.equal(readControlPlaneRecord(controlPlaneRecordPath(huckRoot))?.waiting, null, 'waiting clears before this install starts its own build');
    await fake.build('hello-huck-huck');
  }), () => {}, null);
  for (let at = Date.now(); Date.now() - at < 2000 && !waits.length; await delay(50)) {
    const waiting = readControlPlaneRecord(controlPlaneRecordPath(huckRoot))?.waiting?.reason;
    if (waiting) waits.push(waiting);
  }
  assert.deepEqual(await Promise.all([core, huck]), ['deployed', 'deployed'], 'both installs deploy the new commit');
  assert.deepEqual([readDeployRecord(deployRecordPath(coreRoot))?.tip, readDeployRecord(deployRecordPath(huckRoot))?.tip], [b, b]);
  assert.deepEqual(fake.spans.map(span => span.install), ['core', 'hello-huck-huck'], 'core builds first, then hello-huck-huck');
  assert.ok(fake.spans[1]!.start >= fake.spans[0]!.end, 'the two exports never overlap');
  assert.deepEqual(waits, ["Waits for core's image build to finish"], 'status names the install the second one waits for');
  assert.equal(readControlPlaneRecord(controlPlaneRecordPath(huckRoot))?.waiting, null, 'the wait clears once the build runs');
});

test('integration:deploy-build-lease-error-retried-once — a build that loses its BuildKit lease is retried once and the update record names the retry', { timeout: 30_000 }, async () => {
  const root = await temporaryDirectory('take-turns-retry');
  let attempts = 0;
  const outcome = await deployOnce(deployRecordPath(root), install('core', root, async () => {
    if (++attempts === 1) throw new Error('failed to ingest blobs: lease does not exist: not found');
  }), () => {}, null);
  assert.equal(outcome, 'deployed');
  assert.equal(attempts, 2, 'one retry, no more');
  assert.equal(readControlPlaneRecord(controlPlaneRecordPath(root))?.retried, `The image build of ${b.slice(0, 12)} was retried once without build cache after a BuildKit lease error`);
});

// Pre-GY-4030 installs parse the entire lock file as a PID, including during rollback.
test('integration:two-installs-deploy-builds-take-turns — an older install respects a named holder during rolling updates', async () => {
  const root = await temporaryDirectory('take-turns-legacy');
  const lock = `${root}/images.lock`;
  const legacyMine = `${root}/legacy.lock`;
  await writeFile(legacyMine, String(process.pid));
  const legacyTakeLock = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await link(legacyMine, lock); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      try { process.kill(Number(readFileSync(lock, 'utf8')), 0); return false; } catch { await rm(lock, { force: true }); }
    }
    return false;
  };
  assert.equal(await takeLock(lock, 'core'), true);
  assert.equal(await legacyTakeLock(), false, 'the old install must not remove a live named image lock');
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid), 'the shared lock stays PID-only');
  await rm(lock);
  assert.equal(await legacyTakeLock(), true, 'the old install can acquire after release');
  assert.equal(await takeLock(lock, 'core'), false, 'the new install also respects the old PID-only lock');
});
