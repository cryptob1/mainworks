import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3707: browser-tests/logo-is-the-works.spec.ts failed on the batch gate and passed its re-run. The sign-in
// mark carries width and height attributes, so it is laid out and visible before /favicon.svg has loaded, and the
// spec read its naturalWidth once, right after toBeVisible: on a loaded trial host the image had not arrived yet
// and read 0. The spec now waits for the image to load (naturalWidth > 0), allowing the suite's settled 15 s.
test('unit:test-browser-tests-logo-is-the-works-spec-ts-pinned — the logo spec waits for the mark image to load instead of reading naturalWidth once', () => {
  const spec = readFileSync(join(process.cwd(), 'browser-tests/logo-is-the-works.spec.ts'), 'utf8');
  assert.match(spec, /const settled = \{ timeout: 15_000 \};/, 'the spec names the settled wait');
  assert.match(spec, /await expect\.poll\(\(\) => mark\.evaluate\(node => \(node as HTMLImageElement\)\.naturalWidth\), settled\)\.toBeGreaterThan\(0\);/, 'the spec waits for the mark image to load');
  assert.doesNotMatch(spec, /loaded: \(node as HTMLImageElement\)\.naturalWidth/, 'no one-shot naturalWidth read');
});
