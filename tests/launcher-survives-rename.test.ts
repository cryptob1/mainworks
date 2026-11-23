import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLauncherPath, publishCliRelease } from '../src/install/cli-release.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3742: a deploy rewrites the old launchers (the watch's checkout, deploy/build) from the release it
// publishes. A release that renames its entry and leaves bin/graphyard.mjs a shim importing it must
// still leave every launcher runnable: the deploy copies the release's whole bin set, never the shim alone.

const repo = fileURLToPath(new URL('..', import.meta.url));
const nodeModules = fileURLToPath(new URL('../..', import.meta.resolve('tsx')));

/** A tree holding this checkout's bin/ and a stub src/cli.ts that prints which tree ran and its arguments. */
async function tree(directory: string, name: string) {
  await cp(join(repo, 'bin'), join(directory, 'bin'), { recursive: true });
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'src', 'cli.ts'), `console.log('RAN ${name} ' + process.argv.slice(2).join(' '));\n`);
  await cp(join(repo, 'package.json'), join(directory, 'package.json'));
  await symlink(nodeModules, join(directory, 'node_modules'));
}

test('integration:launcher-survives-rename — after a deploy of a release that renames its CLI entry behind a bin/graphyard.mjs shim, every install launcher still runs status and master status', { timeout: 120_000 }, async () => {
  const home = await temporaryDirectory('launcher-survives-rename');
  const installDir = join(home, 'install'), source = join(home, 'watch-checkout'), build = join(installDir, 'deploy', 'build');
  const release = (sha: string) => join(build, '.graphyard', 'cli-releases', sha);
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  for (const directory of [source, build, release(a), release(b)]) await tree(directory, directory === release(b) ? 'release-b' : 'old');

  // Release b renames the launcher's code to bin/launch.mjs; bin/graphyard.mjs only imports it.
  await rename(join(release(b), 'bin', 'mainworks.mjs'), join(release(b), 'bin', 'launch.mjs'));
  await writeFile(join(release(b), 'bin', 'graphyard.mjs'), "#!/usr/bin/env node\nimport './launch.mjs';\n");

  await publishCliRelease(installDir, source, a);
  await publishCliRelease(installDir, source, b);

  for (const launcher of [installLauncherPath(installDir), join(source, 'bin', 'graphyard.mjs'), join(build, 'bin', 'graphyard.mjs')]) {
    for (const args of [['status'], ['master', 'status']]) {
      const out = execFileSync(process.execPath, [launcher, ...args], { encoding: 'utf8', cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(out.trim(), `RAN release-b ${args.join(' ')}`, `${launcher} ${args.join(' ')} runs the published release`);
    }
  }
  // The loop service's ExecStart (the install launcher) starts the published release's loop.
  const loop = execFileSync(process.execPath, [installLauncherPath(installDir), 'master', 'run'], { encoding: 'utf8', cwd: home });
  assert.equal(loop.trim(), 'RAN release-b master run');
});
