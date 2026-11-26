import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { ensureWarmImage } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3936 AC-1: the coordinator's warm-image build leaves an embedded Postgres that starts, and the
// coordinator checks it (`postgres --version`, a start-and-stop) in the new image before tagging it.
// Trial containers reach no Docker daemon, so a file-backed docker stand-in runs the real build and
// check scripts, with the image's /deps and /warm as directories, against a real copy of the
// embedded-postgres package as `npm ci --ignore-scripts` leaves it: its library links missing.

const source = fileURLToPath(new URL('..', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const cleanup of cleanups) await cleanup().catch(() => {}); });

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

/** docker: images and containers are directories under STATE; `run` runs the script with /deps and /warm rewritten into the container's root. */
const fakeDocker = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const state = process.env.FAKE_DOCKER_STATE, args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(args) + '\n');
const tagsFile = path.join(state, 'tags.json'), tags = fs.existsSync(tagsFile) ? JSON.parse(fs.readFileSync(tagsFile, 'utf8')) : {};
const save = () => fs.writeFileSync(tagsFile, JSON.stringify(tags));
const container = name => path.join(state, 'containers', name);
if (args[0] === 'image' && args[1] === 'inspect') {
  const name = args.at(-1);
  if (name === process.env.FAKE_DOCKER_BASE) { console.log('sha256:' + '3936'.repeat(16)); process.exit(0); }
  if (tags[name]) { console.log(tags[name]); process.exit(0); }
  console.error('Error: No such image: ' + name); process.exit(1);
}
if (args[0] === 'images') { for (const name of Object.keys(tags)) if (name.split(':')[0] === args[1]) console.log(name); process.exit(0); }
if (args[0] === 'commit') {
  const [name, tag] = args.slice(-2), id = 'sha256:' + require('crypto').randomBytes(32).toString('hex');
  fs.cpSync(container(name), path.join(state, 'images', id.slice(7)), { recursive: true, verbatimSymlinks: true });
  tags[tag] = id; save(); process.exit(0);
}
if (args[0] === 'tag') { tags[args[2]] = tags[args[1]]; save(); process.exit(0); }
if (args[0] === 'image' && args[1] === 'rm') { delete tags[args[2]]; save(); process.exit(0); }
if (args[0] === 'rm') { fs.rmSync(container(args.at(-1)), { recursive: true, force: true }); process.exit(0); }
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1], image = args[args.indexOf('--entrypoint') + 2], root = container(name);
  fs.rmSync(root, { recursive: true, force: true });
  if (tags[image]) fs.cpSync(path.join(state, 'images', tags[image].slice(7)), root, { recursive: true, verbatimSymlinks: true });
  else fs.mkdirSync(root, { recursive: true });
  const script = args.at(-1).replace(/(^|[\s"'(=:])\/(deps|warm)\b/g, (_, before, dir) => before + root + '/' + dir);
  const ran = spawnSync('/bin/sh', ['-c', script], { stdio: 'inherit' });
  if (args.includes('--rm')) fs.rmSync(root, { recursive: true, force: true });
  process.exit(ran.status ?? 1);
}
console.error('fake docker: unexpected ' + args.join(' ')); process.exit(2);
`;

/** npm ci: the embedded-postgres package for this platform, as an install with scripts disabled leaves it (no library links). */
const fakeNpm = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
if (process.argv[2] !== 'ci' || !process.argv.includes('--ignore-scripts')) { console.error('fake npm: unexpected ' + process.argv.slice(2).join(' ')); process.exit(2); }
const from = path.join(process.env.FAKE_NPM_MODULES, '@embedded-postgres'), to = path.join('node_modules', '@embedded-postgres');
for (const name of fs.readdirSync(from)) {
  fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true, dereference: false, verbatimSymlinks: true });
  const list = path.join(to, name, 'native', 'pg-symlinks.json');
  for (const link of fs.existsSync(list) ? JSON.parse(fs.readFileSync(list, 'utf8')) : []) fs.rmSync(path.join(to, name, link.target), { force: true });
}
`;

test('integration:warm-image-test-database-starts — the warm image build links the embedded Postgres libraries, and the coordinator runs postgres --version and a start-and-stop in the new image before tagging it', { timeout: 300_000 }, async () => {
  const base = await temporaryDirectory('warm-database');
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), bin = join(base, 'bin'), state = join(base, 'docker');
  for (const dir of [root, bin, state]) execFileSync('mkdir', ['-p', dir]);
  await writeFile(join(bin, 'docker'), fakeDocker); await writeFile(join(bin, 'npm'), fakeNpm);
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'npm'), 0o755);

  git(root, 'init', '-q', '-b', 'main');
  const range = (JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['embedded-postgres']!;
  const manifest = { name: 'fixture', version: '1.0.0', dependencies: { 'embedded-postgres': range } };
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': manifest } })}\n`);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'database');
  const commit = git(root, 'rev-parse', 'HEAD');

  const image = 'mainworks-trial:warm-database';
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, FAKE_DOCKER_BASE: image, FAKE_NPM_MODULES: join(source, 'node_modules') };
  const run: ChildRun = (command, args, options) => defaultChildRun(command, args, { ...options, env: { ...env, ...options?.env } });
  const { tag, built } = await ensureWarmImage({ root, commit, image, run, deadline: Date.now() + 240_000 });
  assert.equal(built, true);

  const calls = (await readFile(join(state, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  const checks = calls.filter(call => call[0] === 'run' && call.includes('--rm'));
  assert.equal(checks.length, 2, 'the coordinator runs two checks in the new image');
  assert.match(checks[0]!.at(-1)!, /"\$bin\/postgres" --version/);
  assert.match(checks[1]!.at(-1)!, /initdb.*pg_ctl.*start.*pg_ctl.*stop/s);
  for (const check of checks) assert.ok(check.includes('--cap-drop=ALL') && check.join(' ').includes('--user 1000:1000') && check.includes('--security-opt=no-new-privileges'), check.join(' '));
  const tagAt = calls.findIndex(call => call[0] === 'tag' && call[2] === tag);
  assert.ok(tagAt > calls.indexOf(checks[1]!), 'the image is tagged only after both checks pass');

  // The tagged image's Postgres starts: run it the way a shard does, from the committed image.
  const id = JSON.parse(await readFile(join(state, 'tags.json'), 'utf8'))[tag] as string;
  const pgBin = String(execFileSync('sh', ['-c', `echo ${join(state, 'images', id.slice(7))}/deps/node_modules/@embedded-postgres/*/native/bin`], { encoding: 'utf8' })).trim();
  assert.match(execFileSync(join(pgBin, 'postgres'), ['--version'], { encoding: 'utf8' }), /postgres \(PostgreSQL\) \d+/);
  const data = join(base, 'data');
  execFileSync(join(pgBin, 'initdb'), ['-D', data, '-U', 'check', '--auth=trust', '--no-sync'], { stdio: 'ignore' });
  execFileSync(join(pgBin, 'pg_ctl'), ['-D', data, '-o', `-c listen_addresses= -k ${base}`, '-w', 'start'], { stdio: 'ignore' });
  assert.match(execFileSync(join(pgBin, 'pg_ctl'), ['-D', data, 'status'], { encoding: 'utf8' }), /server is running/);
  execFileSync(join(pgBin, 'pg_ctl'), ['-D', data, '-w', 'stop'], { stdio: 'ignore' });
});
