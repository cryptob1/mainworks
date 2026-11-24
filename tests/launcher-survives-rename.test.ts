import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { cp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLauncherPath, publishCliRelease } from '../src/install/cli-release.js';
import { MERGE_PROTOCOL } from '../src/protocol-version.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const exec = promisify(execFile);

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

// AC-3: the master loop service restarts onto the deployed release and its first cycle completes, on
// this checkout's real CLI (not a stub), through the launchers its ExecStart may name: the install's
// stable launcher and deploy/build's, which the deploy rewrote.
test('e2e:launcher-survives-rename — after a deploy of a release that renames its CLI entry, the master loop restarts through each launcher and its first cycle completes', { timeout: 170_000 }, async () => {
  const home = await temporaryDirectory('launcher-survives-rename-loop');
  const installDir = join(home, 'install'), source = join(home, 'watch-checkout'), build = join(installDir, 'deploy', 'build'), project = join(home, 'project');
  const release = (sha: string) => join(build, '.graphyard', 'cli-releases', sha);
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  for (const directory of [source, build, release(a), release(b)]) {
    await cp(join(repo, 'bin'), join(directory, 'bin'), { recursive: true });
    await symlink(join(repo, 'src'), join(directory, 'src'));
    await cp(join(repo, 'package.json'), join(directory, 'package.json'));
    await symlink(nodeModules, join(directory, 'node_modules'));
  }
  await rename(join(release(b), 'bin', 'mainworks.mjs'), join(release(b), 'bin', 'launch.mjs'));
  await writeFile(join(release(b), 'bin', 'graphyard.mjs'), "#!/usr/bin/env node\nimport './launch.mjs';\n");
  await publishCliRelease(installDir, source, a);
  await publishCliRelease(installDir, source, b);

  const coordinator = { id: 'master', role: 'coordinator' };
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') return res.end(JSON.stringify({ actor: coordinator, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, build: { commit: null, protocol: MERGE_PROTOCOL } }));
    if (req.url === '/api/work-snapshot') return res.end(JSON.stringify({ now: new Date().toISOString(), work: [] }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  try {
    await mkdir(join(project, '.graphyard'), { recursive: true });
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/owner/project.git']);
    const credentialFile = join(home, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const env = { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN: undefined, GRAPHYARD_TOKEN_FILE: undefined };
    // master.json names deploy/build's launcher (a file the deploy rewrote); the unit's ExecStart may run either launcher.
    await writeFile(join(project, '.graphyard', 'master.json'), JSON.stringify({ version: 1, url, credentialFile, cliPath: join(build, 'bin', 'graphyard.mjs'), repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run: { intervalSeconds: 5, deploymentShaField: 'commit' } }), { mode: 0o600 });
    for (const launcher of [installLauncherPath(installDir), join(build, 'bin', 'graphyard.mjs')]) {
      const { stdout } = await exec(process.execPath, [launcher, 'master', 'run', '--once'], { cwd: project, env });
      const run = JSON.parse(stdout);
      assert.equal(run.cycles, 1, `${launcher}: the restarted loop's first cycle ran`);
      assert.equal(run.failedCycles, 0, `${launcher}: the first cycle completed`);
    }
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});
