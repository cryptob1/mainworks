import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun } from '../src/child-runner.js';
import { ensureWarmImage } from '../src/merge-writer/remote-shards.js';
import { trialImage } from '../src/merge-writer/trial-container.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3936 AC-1: a warm image built by the coordinator, in real Docker, holds an embedded Postgres
// that starts as the shards' non-root user with capabilities dropped.

const source = fileURLToPath(new URL('..', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const cleanup of cleanups) await cleanup().catch(() => {}); });

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

/** This repository's lockfile cut down to embedded-postgres and what it needs, so the build installs only those. */
async function databaseOnlyLock() {
  const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
  const range = (JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['embedded-postgres']!;
  const kept: Record<string, unknown> = {}, queue = ['embedded-postgres'];
  for (const name of queue) {
    const key = `node_modules/${name}`, entry = lock.packages[key];
    if (!entry || kept[key]) continue;
    kept[key] = entry;
    queue.push(...Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }));
  }
  const root = { name: 'fixture', version: '1.0.0', dependencies: { 'embedded-postgres': range } };
  return { manifest: root, lock: { name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': root, ...kept } } };
}

test('integration:warm-image-test-database-starts — the warm image built in Docker runs postgres --version and starts and stops a cluster as uid 1000 with capabilities dropped', { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('warm-database');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const { manifest, lock } = await databaseOnlyLock();
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'database only');
  const commit = git(root, 'rev-parse', 'HEAD');

  const { tag, built } = await ensureWarmImage({ root, commit, image: trialImage(), run: defaultChildRun, deadline: Date.now() + 540_000 });
  cleanups.push(async () => { await defaultChildRun('docker', ['image', 'rm', tag]); });
  assert.equal(built, true);

  const inImage = (script: string) => defaultChildRun('docker', ['run', '--rm', '--user', '1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', '/bin/sh', tag, '-c',
    `bin=$(echo /deps/node_modules/@embedded-postgres/*/native/bin) && ${script}`], { timeoutMs: 120_000 });
  assert.match(String(await inImage('"$bin/postgres" --version')), /postgres \(PostgreSQL\) \d+/);
  const started = String(await inImage('d=$(mktemp -d) && "$bin/initdb" -D "$d/data" -U check --auth=trust --no-sync >/dev/null && "$bin/pg_ctl" -D "$d/data" -o "-c listen_addresses= -k $d" -w start >/dev/null && "$bin/pg_ctl" -D "$d/data" status && "$bin/pg_ctl" -D "$d/data" -w stop'));
  assert.match(started, /server is running/);
  assert.match(started, /server stopped/);
});
