// GY-3733: an install's update pulls megabytes, not two gigabytes — the published trial image's heavy
// layers (apt, Playwright browsers, global CLIs) come from the registry cache and pin what they install,
// with nothing that changes per commit above them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishVerified } from '../src/publish-verified.js';
import { execFileSync } from 'node:child_process';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
/** The Dockerfile's instructions, continuation lines joined, comments dropped. */
const instructions = dockerfile.replace(/\\\n/g, ' ').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
const stage = (name: string) => {
  const start = instructions.findIndex(line => new RegExp(`^FROM .* AS ${name}$`, 'i').test(line));
  assert.ok(start >= 0, `the Dockerfile has a ${name} stage`);
  const end = instructions.findIndex((line, index) => index > start && /^FROM /i.test(line));
  return instructions.slice(start, end < 0 ? undefined : end);
};

test('unit:trial-image-heavy-layers-are-cached — no per-commit ARG, LABEL or source COPY sits above the apt, Playwright and global-CLI steps, which pin what they install, and the publish build uses the registry cache', async () => {
  const trial = stage('trial');
  const apt = trial.findIndex(line => /^RUN apt-get update/.test(line));
  const browsers = trial.findIndex(line => /^RUN .*playwright\/cli\.js install/.test(line));
  const clis = trial.findIndex(line => /^RUN npm install --global /.test(line));
  assert.ok(apt > 0 && browsers > apt && clis > browsers, 'the trial stage installs apt packages, then Playwright browsers, then global CLIs');
  for (const line of trial.slice(1, clis + 1)) assert.doesNotMatch(line, /^(ARG|LABEL|COPY|ADD) /i, `nothing per-commit sits above the heavy layers: ${line}`);
  // Pinned: the base image by digest, the global CLIs by exact version, and the browsers by the lockfile alone.
  assert.match(trial[0]!, /^FROM \S+@sha256:[0-9a-f]{64} AS trial$/i, 'the trial base image is pinned by digest');
  for (const name of trial[clis]!.replace(/^RUN npm install --global /, '').split(/\s+/)) assert.match(name, /^@?[^@\s]+@\d+\.\d+\.\d+$/, `${name} is pinned to an exact version`);
  const source = trial[browsers]!.match(/--mount=from=(\S+?),/)?.[1];
  assert.ok(source, 'the browsers install from a stage\'s locked node_modules');
  assert.deepEqual(stage(source).slice(1).filter(line => !/^(WORKDIR|ENV) /i.test(line)), ['COPY package.json package-lock.json ./', 'RUN npm ci'], `the ${source} stage holds the lockfile and its install alone, so a source change does not change the browser layer`);

  // The publish build reads and writes the registry's layer cache.
  const calls: string[] = [];
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await publishVerified(commit, { root, env: { GITHUB_TOKEN: 'token' }, run: (command, args) => {
    if (command === 'git' || command === 'tar') return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 30 });
    calls.push([command, ...args].join(' ')); return '';
  } });
  const build = calls.find(call => call.startsWith('docker buildx build '))!;
  assert.match(build, / --cache-from type=registry,ref=ghcr\.io\/cryptob1\/graphyard-trial:buildcache /);
  assert.match(build, / --cache-to type=registry,ref=ghcr\.io\/cryptob1\/graphyard-trial:buildcache,mode=max /);
  assert.match(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8'), /docker\/setup-buildx-action/, 'the workflow selects a buildx builder that can export a registry cache');
});
