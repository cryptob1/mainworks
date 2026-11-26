import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heldVariable } from '../src/master/verification-slots.js';

// GY-3925 (updating GY-3323): Try it runs from the repository checkout with no unpublished npx block.
const root = fileURLToPath(new URL('..', import.meta.url));
const start = readFileSync(join(root, 'README.md'), 'utf8').split('## Try it\n')[1]?.split('\n## ')[0] ?? '';
const blocks = [...start.matchAll(/```sh\n([^`]+)```/g)].map(match => ({ at: match.index, lines: match[1]!.trim().split('\n') }));
const url = 'https://github.com/cryptob1/mainworks.git';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// GY-3630: a compute machine's trial container runs as a user that does not own the checkout, and git's
// transport refuses to clone a repository another user owns (GY-3597). The clone line becomes a checkout
// that borrows this checkout's objects instead, one command per line so `sh -e` stops on its failure.
function quickStartScript(lines: string[]) {
  const objects = git('rev-parse', '--path-format=absolute', '--git-path', 'objects'), head = git('rev-parse', 'HEAD');
  return lines.map(line => line
    .replace(`git clone ${url} && cd mainworks`, ['git init -q mainworks', 'cd mainworks', `echo ${JSON.stringify(objects)} > .git/objects/info/alternates`, `git checkout -q --detach ${head}`].join('\n'))
    .replace(/^npm ci && npm run build$/, `ln -s ${JSON.stringify(join(root, 'node_modules'))} node_modules\nnpm run build`)
    .replace(/^npm ci$/, `ln -s ${JSON.stringify(join(root, 'node_modules'))} node_modules`)
    .replace(/ up --repo OWNER\/NAME$/, ' up --help')).join('\n');
}

test('e2e:readme-quick-start-runs — Try it clones, installs, builds and runs up from the checkout, with no unpublished npx block', { timeout: 900_000 }, () => {
  const [checkout] = blocks;
  assert.ok(checkout, 'Try it has a checkout block');
  assert.equal(blocks.length, 1, 'Try it has no unpublished npx block');
  assert.deepEqual(checkout.lines, [`git clone ${url} && cd mainworks`, 'npm ci && npm run build', 'node bin/mainworks.mjs up --repo OWNER/NAME']);

  // Run the block in a scratch directory: the checkout borrows this one's objects, npm ci links its installed
  // dependencies, and up prints its usage; the build runs exactly as written, inside this run's verification slot.
  const scratch = mkdtempSync(join(tmpdir(), 'gy-quick-start-'));
  try {
    const script = quickStartScript(checkout.lines);
    const output = execFileSync('sh', ['-ec', script], { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, [heldVariable]: '1' } });
    assert.match(output, /up --repo OWNER\/NAME/, 'the checkout CLI answers up');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('unit:readme-quick-start-runs-pinned — the Quick start checks out on a compute machine, where another user owns the checkout and git refuses to clone it', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gy-quick-start-owner-'));
  try {
    const machine = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: root, GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: join(scratch, 'mainworks'), GIT_ALLOW_PROTOCOL: 'https' };
    const script = `${quickStartScript([blocks[0]!.lines[0]!])}\ncat package.json`;
    const output = execFileSync('sh', ['-ec', script], { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...machine } });
    assert.match(output, /"name": "mainworks"/, 'the checkout holds this repository');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
