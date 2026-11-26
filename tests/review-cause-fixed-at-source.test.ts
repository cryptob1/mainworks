import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completePreflight } from '../src/cli/complete.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3939: a weakened assertion was review's largest rework cause over 24 h (GY-3881, GY-3894,
// GY-3919, GY-3925). complete now asks the worker to rule on each changed assertion first.

const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/.test(name)));
const keywords = "  assert.ok(keywords.includes('agents'), 'package.json keywords name the search terms');";

test('integration:review-cause-fixed-at-source — complete refuses a head that drops an existing assertion until a commit rules on it', async () => {
  const root = await temporaryDirectory('review-cause');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: clean }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'worker'); git('config', 'user.email', 'worker@example.com'); git('config', 'commit.gpgsign', 'false');
  await mkdir(join(root, 'tests'));
  const file = (lines: string[]) => writeFile(join(root, 'tests/readme.test.ts'), ["test('readme', () => {", "  assert.ok(readme.includes('npm'));", ...lines, '});', ''].join('\n'));
  await file([keywords]); git('add', '-A'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');

  // GY-3925's finding: the keywords check deleted from tests/readme-commands-and-links-resolve.test.ts.
  git('checkout', '-qb', 'graphyard/gy-1-1');
  await file([]); git('commit', '-qam', 'GY-1: shorten the readme test');
  const work = { key: 'GY-1', type: 'chore', criteria: [] };
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), (error: Error) => {
    assert.match(error.message, /tests\/readme\.test\.ts:3/);
    assert.match(error.message, /kept meaning/);
    return true;
  });

  // A commit that rules the change "weakened" is refused too; ruled "kept meaning", it submits.
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: tests/readme.test.ts:3 — weakened');
  await assert.rejects(completePreflight(root, work, git('rev-parse', 'HEAD')), /weakened/);
  git('reset', '-q', '--hard', 'HEAD~1');
  git('commit', '-q', '--allow-empty', '-m', 'GY-1: rulings\n\ntests/readme.test.ts:3 — kept meaning: package.json has no keywords any more');
  await completePreflight(root, work, git('rev-parse', 'HEAD'));
});
