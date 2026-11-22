import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// GY-3668: tests/product-review-builds-before-serve.test.ts failed on main and passed on its re-run.
// It hardcoded servePort = 4397, the same port tests/product-review-environment.test.ts serves on, and
// both files run on this machine at once, so one fixture's served head could answer the other's (or
// refuse its listen). It must allocate an ephemeral free port with freePort().

test('unit:product-review-builds-before-serve-pinned — the fixture allocates a free serve port instead of hardcoding one', async () => {
  const source = await readFile(new URL('./product-review-builds-before-serve.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bconst\s+servePort\s*=\s*\d+/, 'hardcoding a fixed serve port collides across concurrent runs');
  assert.match(source, /\bservePort\s*=\s*await\s+freePort\(\)/, 'the fixture allocates an ephemeral free port with freePort()');
});
