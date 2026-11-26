import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { ensureWarmImage, warmCommitOnHosts } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3914 AC-3: The warm-image build runs dependency installation with install scripts disabled,
// as a non-root user, with all capabilities dropped, and the build step likewise; a head whose
// lockfile adds a package with a postinstall script builds without running it, and trials on the
// resulting image pass as before. A unit case asserts the build command's flags.

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup().catch(() => {});
});

const identity = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

test('unit:warm-image-build-runs-unprivileged-without-install-scripts — warm-image build commands disable install scripts, drop all capabilities, and run as non-root', async () => {
  const root = await temporaryDirectory('warm-image-flags-repo');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }) + '\n');
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }) + '\n');
  await writeFile(join(root, 'bin/built-entry.mjs'), 'console.log("built");\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  const commit = git(root, 'rev-parse', 'HEAD');

  const dockerRunScripts: string[] = [];
  const image = 'mainworks-trial:unit-flags';
  const digest = `sha256:${'ef56'.repeat(16)}`;
  const localImages = new Set<string>([image]);

  const run: ChildRun = async (command, args) => {
    if (command === 'git') return execFileSync('git', args, { encoding: 'utf8' });
    if (command === 'docker') {
      if (args[0] === 'image' && args[1] === 'inspect') {
        const tag = args.at(-1)!;
        if (!localImages.has(tag)) throw new Error(`No such image: ${tag}`);
        return tag === image ? digest : `sha256:${'11'.repeat(32)}`;
      }
      if (args[0] === 'images') return [...localImages].filter(t => t.startsWith('graphyard-warm:')).join('\n');
      if (args[0] === 'commit') { localImages.add(args.at(-1)!); return ''; }
      if (args[0] === 'rm') return '';
      return '';
    }
    if (command === 'sh') {
      const script = args[1] ?? '';
      if (script.includes('docker run ')) {
        dockerRunScripts.push(script);
        return '';
      }
      if (script.includes('receive-image ')) return '';
      return '';
    }
    if (command === 'ssh') {
      if (args.includes('-G')) return 'hostname 127.0.0.1\nuser gy-compute\n';
      return '';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  // Trigger v2 warm image build (ensureWarmImage).
  await ensureWarmImage({ root, commit, image, run, deadline: Date.now() + 60_000 });
  // Trigger v1 warm image build too (via warmCommitOnHosts targeting a v1 host).
  await warmCommitOnHosts({
    root,
    commit,
    image,
    hosts: ['gy-compute@v1box'],
    read: async () => [
      { name: 'local', cores: 4, busy: 0, steal: 0, celsius: null, limit: 85, away: false },
      { name: 'gy-compute@v1box', cores: 4, busy: 0, steal: 0, celsius: null, limit: 85, away: false, verbs: ['probe:1', 'receive-pack:1', 'receive-image:1', 'prepare-run:1', 'run-shard:2', 'fetch-records:1', 'clean:1'] },
    ],
    run,
    deadline: Date.now() + 60_000,
  });

  assert.equal(dockerRunScripts.length, 2, `expected v2 and v1 warm-image docker run commands, got ${dockerRunScripts.length}`);
  for (const script of dockerRunScripts) {
    assert.match(script, /npm ci\b[^'"\n]*--ignore-scripts/, `npm ci must disable install scripts: ${script}`);
    assert.match(script, /--cap-drop=ALL\b/, `docker run must drop all capabilities: ${script}`);
    assert.match(script, /--security-opt=no-new-privileges\b/, `docker run must set no-new-privileges: ${script}`);
    assert.doesNotMatch(script, /--user\s+(?:0(?::0)?|root(?::root)?)\b/, `docker run must not run as root: ${script}`);
    assert.match(script, /--user\s+[1-9]\d*(?::\d+)?\b/, `docker run must run as a non-root user: ${script}`);
  }
});

test('unit:warm-image-build-runs-unprivileged-without-install-scripts — a package with a postinstall script in the lockfile installs without running postinstall', async () => {
  const dir = await temporaryDirectory('warm-image-postinstall');
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'postinstall-ran.txt');
  const pkgDir = join(dir, 'evil-pkg');
  const appDir = join(dir, 'app');
  await mkdir(pkgDir, { recursive: true });
  await mkdir(appDir, { recursive: true });

  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
    name: 'evil-pkg',
    version: '1.0.0',
    scripts: { postinstall: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pwned')"` },
  }, null, 2) + '\n');
  await writeFile(join(pkgDir, 'index.js'), 'module.exports = 42;\n');

  // Pack evil-pkg into a local tarball and generate a real package-lock.json.
  const tgz = execFileSync('npm', ['pack', '--pack-destination', dir, pkgDir], { encoding: 'utf8' }).trim().split('\n').at(-1)!;
  await writeFile(join(appDir, 'package.json'), JSON.stringify({
    name: 'app',
    version: '1.0.0',
    dependencies: { 'evil-pkg': `file:${join(dir, tgz)}` },
  }, null, 2) + '\n');
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: appDir, stdio: 'pipe' });

  // Run npm ci with the same --ignore-scripts flags the warm-image build uses.
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDir,
    env: { ...process.env, HOME: dir },
    stdio: 'pipe',
  });

  assert.equal(existsSync(marker), false, 'postinstall script must not run during warm-image npm ci --ignore-scripts');
  assert.equal(existsSync(join(appDir, 'node_modules', 'evil-pkg', 'index.js')), true, 'package files are still installed');
});
