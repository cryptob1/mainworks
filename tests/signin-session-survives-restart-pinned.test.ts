import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runTests } from './helpers/run-tests.js';

// GY-3753: the five-run sign-in proof and the master-page proof each start a browser run from one
// checkout, and both built into .graphyard/browser-dist. A build empties its directory first, so a page
// loaded meanwhile got no script and stayed blank past the spec's wait for Sign out.
test('unit:signin-session-survives-restart-pinned — two browser runs in one checkout each build, serve and keep their own bundle', async () => {
  // Inside the checkout so the config's imports resolve: the spec reports what the run would build.
  await mkdir('.graphyard', { recursive: true });
  const directory = await mkdtemp(resolve('.graphyard/browser-bundle-'));
  try {
    const config = join(directory, 'playwright.config.ts');
    await writeFile(config, `import config from ${JSON.stringify(resolve('playwright.config.ts'))};
export default { ...config, testDir: ${JSON.stringify(directory)}, webServer: undefined, metadata: { command: config.webServer.command } };\n`);
    await writeFile(join(directory, 'bundle.spec.ts'), `import { test } from '@playwright/test';
test('bundle', ({}, info) => { console.log('BUNDLE ' + JSON.stringify({ dist: process.env.GRAPHYARD_BROWSER_DIST, command: info.config.metadata.command })); });\n`);
    const run = async () => {
      const finished = await runTests({ browser: true, args: ['--config', config, '--reporter=line'], stdio: 'pipe' });
      assert.equal(finished.code, 0, finished.stdout + finished.stderr);
      return JSON.parse(finished.stdout.match(/BUNDLE (\{.*\})/)![1]) as { dist: string; command: string };
    };
    const [first, second] = [await run(), await run()];
    const outDirs = (command: string) => [...command.matchAll(/--outDir "?([^" ]+)/g)].map(match => match[1]);
    for (const { dist, command } of [first, second])
      assert.deepEqual(outDirs(command), [dist, dist], 'a run builds and serves the bundle its specs are handed');
    assert.notEqual(first.dist, second.dist, 'another run’s build never empties the bundle this run serves');
    for (const file of (await readdir('browser-tests')).filter(name => name.endsWith('.spec.ts')))
      assert.doesNotMatch(await readFile(join('browser-tests', file), 'utf8'), /\.graphyard\/browser-dist/, `${file} serves its own run's bundle`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
