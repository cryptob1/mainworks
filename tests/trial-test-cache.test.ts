import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { cachedPasses, recordPasses, testResultKeys } from '../src/merge-writer/trial-caches.js';

// GY-3639: a doc, a case or a stylesheet edited beside code no longer empties the trial's test
// cache. Each test file's key decides alone: its content, the sources it imports and the files it
// reads as data.

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
};
const tests = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/case.test.ts', 'tests/fixture.test.ts'];

/** A worktree whose four tests all passed in an earlier trial; `change` is the next head, and the result is the tests it runs again. */
async function rerun(change: Record<string, string>) {
  const root = await temporaryDirectory('trial-test-cache'), caches = await temporaryDirectory('trial-test-cache-store');
  write(root, {
    'tsconfig.json': '{}\n', 'README.md': 'readme\n', 'docs/guide.md': 'guide\n', 'web/style.css': 'a {}\n', 'web/logo.svg': '<svg/>\n',
    'e2e/cases/smoke.json': '{"id":"smoke"}\n',
    'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n',
    'tests/a.test.ts': "import { a } from '../src/a.js';\n",
    'tests/b.test.ts': "import { b } from '../src/b.js';\n",
    'tests/case.test.ts': "import { load } from './helpers/load.js';\nload('smoke');\n",
    'tests/helpers/load.ts': "import { readFileSync } from 'node:fs';\nexport const load = (id: string) => readFileSync(`e2e/cases/${id}.json`, 'utf8');\nexport const smoke = readFileSync('e2e/cases/smoke.json', 'utf8');\n",
    'tests/fixture.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('./fixtures/data.txt', import.meta.url));\n",
    'tests/fixtures/data.txt': 'one\n',
  });
  await recordPasses(caches, [...testResultKeys(root, tests, 'deps').values()]);
  write(root, change);
  const cached = cachedPasses(caches, testResultKeys(root, tests, 'deps'));
  return tests.filter(file => !cached.has(file));
}

const nonCode = { 'README.md': 'readme, edited\n', 'docs/guide.md': 'guide, edited\n', 'docs/new.md': 'new\n', 'e2e/cases/new.json': '{"id":"new"}\n', 'web/style.css': 'a { color: red }\n', 'web/logo.svg': '<svg></svg>\n' };

test('unit:doc-edits-keep-the-test-cache — code plus a doc, a new case, a stylesheet and an image: only the test importing the changed module runs', async () => {
  assert.deepEqual(await rerun({ ...nonCode, 'src/a.ts': 'export const a = 2;\n' }), ['tests/a.test.ts']);
});

test('unit:doc-edits-keep-the-test-cache — a doc only: every test is served from the cache', async () => {
  assert.deepEqual(await rerun(nonCode), []);
});

test('unit:doc-edits-keep-the-test-cache — a changed fixture or case runs the test that reads it, directly or through its helper, and no other', async () => {
  assert.deepEqual(await rerun({ 'tests/fixtures/data.txt': 'two\n' }), ['tests/fixture.test.ts']);
  assert.deepEqual(await rerun({ 'e2e/cases/smoke.json': '{"id":"smoke","steps":[]}\n' }), ['tests/case.test.ts']);
});

test('unit:doc-edits-keep-the-test-cache — a changed module runs the test that imports it', async () => {
  assert.deepEqual(await rerun({ 'src/b.ts': 'export const b = 2;\n' }), ['tests/b.test.ts']);
});

test('unit:doc-edits-keep-the-test-cache — a changed tsconfig runs every test', async () => {
  assert.deepEqual(await rerun({ 'tsconfig.json': '{"compilerOptions":{"strict":true}}\n' }), tests);
});

test('unit:doc-edits-keep-the-test-cache — a test that lists a directory runs again when a file is added to it', async () => {
  const lister = { 'tests/a.test.ts': "import { readdirSync } from 'node:fs';\nimport { a } from '../src/a.js';\nreaddirSync('e2e/cases');\n" };
  const root = await temporaryDirectory('trial-test-cache-list'), caches = await temporaryDirectory('trial-test-cache-list-store');
  write(root, { 'src/a.ts': 'export const a = 1;\n', 'e2e/cases/smoke.json': '{}\n', ...lister });
  await recordPasses(caches, [...testResultKeys(root, ['tests/a.test.ts'], 'deps').values()]);
  assert.equal(cachedPasses(caches, testResultKeys(root, ['tests/a.test.ts'], 'deps')).size, 1);
  write(root, { 'e2e/cases/new.json': '{}\n' });
  assert.equal(cachedPasses(caches, testResultKeys(root, ['tests/a.test.ts'], 'deps')).size, 0);
});
