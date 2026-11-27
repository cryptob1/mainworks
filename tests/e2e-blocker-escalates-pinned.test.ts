import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDashboardBuilt } from '../src/dashboard-build.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3967: the daily catalog's remote shards run scripts/e2e-shard.mjs over the commit's bare checkout,
// which has no dist/. The fixture serve then answered with no dashboard, so e2e:blocker-escalates timed
// out at step 8 filling "Access token" (and e2e:board-queue-not-blocked at its first page check).
// The shard now builds the dashboard into the checkout before any case is served.

test('unit:e2e-blocker-escalates-pinned — a catalog shard builds the dashboard before it serves its cases', async () => {
  const shard = readFileSync(join(process.cwd(), 'scripts', 'e2e-shard.mjs'), 'utf8');
  const built = shard.indexOf('await ensureDashboardBuilt(worktree)'), served = shard.indexOf('await runTrialE2eCases(');
  assert.ok(built >= 0, 'the shard builds the dashboard into its checkout');
  assert.ok(built < served, 'the dashboard is built before the cases are served');

  // On a checkout with no dist/, the build leaves dist/index.html beside the CLI files already there.
  const checkout = await temporaryDirectory('e2e-shard-dashboard');
  await mkdir(join(checkout, 'dist'), { recursive: true });
  await writeFile(join(checkout, 'dist', 'cli.mjs'), '');
  const build = async (outDir: string) => { await mkdir(join(outDir, 'assets'), { recursive: true }); await writeFile(join(outDir, 'index.html'), '<label>Access token</label>'); await writeFile(join(outDir, 'assets', 'main.js'), ''); };
  assert.equal(await ensureDashboardBuilt(checkout, build), true);
  assert.match(readFileSync(join(checkout, 'dist', 'index.html'), 'utf8'), /Access token/);
  assert.ok(existsSync(join(checkout, 'dist', 'assets', 'main.js')) && existsSync(join(checkout, 'dist', 'cli.mjs')));
  assert.equal(await ensureDashboardBuilt(checkout, async () => assert.fail('a built dashboard is not rebuilt')), false);
});
