import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTests } from './helpers/run-tests.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-4079: the side-by-side test started its 5 s wait as the tick began, so when reconcileReviews
// (its first step opens the loop-state Postgres, slow when cold or under load) took longer than that,
// the wait expired before any launch began. The seam holds reconcileReviews' first step for 6 s.
const seam = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rm = fs.promises.rm;
let held = false;
fs.promises.rm = async (path, ...rest) => {
  if (!held && String(path).includes('review-ledger') && String(path).endsWith('.lock')) {
    held = true;
    await new Promise(resolve => setTimeout(resolve, 6_000));
  }
  return rm(path, ...rest);
};
syncBuiltinESMExports();
`;

test('unit:reviews-launch-side-by-side-pinned — four reviews still launch side by side when the tick takes over 5 s to reach its first launch', async () => {
  const preload = join(await temporaryDirectory('reviews-launch-side-by-side-pinned'), 'preload.mjs');
  await writeFile(preload, seam);
  const finished = await runTests({
    args: ['--test-name-pattern=one slow launch leaves the other three started', 'tests/reviews-launch-side-by-side.test.ts'],
    stdio: 'pipe',
    environment: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() },
  });
  assert.equal(finished.code, 0, `tests/reviews-launch-side-by-side.test.ts failed when reconcileReviews was slow:\n${finished.stderr.slice(-4_000)}\n${finished.stdout.slice(-6_000)}`);
});
