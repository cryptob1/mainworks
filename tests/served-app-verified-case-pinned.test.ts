import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { splitLocalOnlyTests } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { ensureDashboardBuilt } from './helpers/run-tests.js';

// GY-3656: tests/served-app-verified-case.test.ts drives Chromium through projectCaseSuite against
// the built dashboard in dist/. On remote trial shards:
// 1. splitLocalOnlyTests must treat projectCaseSuite files as browser tests when the trial image
//    lacks a browser (remoteBrowser: false), rather than sending them to a browserless shard.
// 2. Multiple remote shards share one checkout (<run>/repo); building the dashboard on demand must
//    serialize behind a lock and publish into dist/ without wiping sibling dist/ entries or racing
//    another shard's reads.

const repo = new URL('..', import.meta.url).pathname;

test('unit:served-app-verified-case-pinned — served-app-verified-case is recognized as a browser test and concurrent shard dashboard builds serialize without wiping dist/', async () => {
  const split = await splitLocalOnlyTests(
    ['tests/served-app-verified-case.test.ts'],
    file => readFile(join(repo, file), 'utf8'),
    { remoteBrowser: false },
  );
  assert.deepEqual(split, {
    remoteable: [],
    localOnly: ['tests/served-app-verified-case.test.ts'],
    browserLocalOnly: true,
  });

  const checkout = await temporaryDirectory('served-app-verified-shared-shard');
  await mkdir(join(checkout, 'dist'), { recursive: true });
  await writeFile(join(checkout, 'dist', 'cli.mjs'), '// built by another shard\n');

  let builds = 0;
  const fakeBuild = async (outDir: string) => {
    builds++;
    await new Promise(resolve => setTimeout(resolve, 120));
    await mkdir(join(outDir, 'assets'), { recursive: true });
    await writeFile(join(outDir, 'assets', 'app.js'), 'console.log("ok");\n');
    await writeFile(join(outDir, 'index.html'), '<!doctype html><script src="/assets/app.js"></script>\n');
  };

  const results = await Promise.all([
    ensureDashboardBuilt(checkout, fakeBuild, { pollMs: 20 }),
    ensureDashboardBuilt(checkout, fakeBuild, { pollMs: 20 }),
  ]);

  assert.equal(builds, 1, 'concurrent shards sharing one checkout build the dashboard once');
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await readFile(join(checkout, 'dist', 'cli.mjs'), 'utf8'), '// built by another shard\n', 'sibling dist/cli.mjs is preserved');
  assert.match(await readFile(join(checkout, 'dist', 'index.html'), 'utf8'), /app\.js/);
  assert.match(await readFile(join(checkout, 'dist', 'assets', 'app.js'), 'utf8'), /console\.log/);
});
