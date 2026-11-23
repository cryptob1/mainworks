import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideText, guideTopicList } from '../src/guide.js';
import { publishedPackage } from '../src/publish-verified.js';

// GY-3230: the unscoped npm name `mainworks` belongs to someone else, so Mainworks publishes as
// @cryptob1/graphyard and nothing a user reads may tell them to run the unscoped package.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const help = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), ...args], { encoding: 'utf8' });
const unscoped = /npx\s+(?:(?:--yes|-y)\s+)?(?:graphyard|mainworks)\b/;
const negativeAssertion = /\b(?:not\.toContainText|doesNotMatch)\b/;
const textFile = /\.(md|ts|tsx|js|mjs|json|html|txt|ya?ml)$/;

/** Every tracked text file in the repository, except this test's own fixtures: scratch trees other
 *  tests create beside the repository never count as files a user reads. */
function repositoryTexts(): string[] {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const self = relative(root, join(root, 'tests/npm-package-name.test.ts'));
  return tracked.filter(path => textFile.test(path) && path !== self).map(path => join(root, path));
}

test('unit:tests/npm-package-name.test.ts — package.json names mainworks with the mainworks bin and the old command shim, and publishes as @cryptob1/graphyard', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.name, 'mainworks');
  assert.deepEqual(manifest.bin, { mainworks: './bin/mainworks.mjs', graphyard: './bin/graphyard.mjs' });
  assert.equal(publishedPackage(manifest, 'abc', '2026.1.1').name, '@cryptob1/graphyard');
});

test('unit:tests/npm-package-name.test.ts — the README Quick start runs npx @cryptob1/graphyard up', () => {
  const start = read('README.md').split('## Quick start\n')[1]!.split('\n## ')[0]!;
  assert.match(start, /npx @cryptob1\/graphyard up --repo OWNER\/NAME/);
});

test('unit:tests/npm-package-name.test.ts — repository files, guide text and printed help never say unscoped npx mainworks', () => {
  const texts: Record<string, string> = {
    'mainworks --help': help('--help'),
    'mainworks up --help': help('up', '--help'),
  };
  for (const topic of guideTopicList) texts[`guide ${topic}`] = guideText(topic);
  for (const path of repositoryTexts()) texts[relative(root, path)] = readFileSync(path, 'utf8');
  for (const [name, text] of Object.entries(texts)) {
    const check = /^(?:tests|browser-tests)\//.test(name) ? text.split('\n').filter(line => !negativeAssertion.test(line)).join('\n') : text;
    assert.doesNotMatch(check, unscoped, `${name} tells a user to run unscoped npx mainworks`);
  }
});
