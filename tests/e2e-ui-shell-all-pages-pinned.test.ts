import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3970: e2e:ui-shell-all-pages walks every page in the router, the Lead page among them, whose terminal
// fetches xterm.js from the CDN. The spec never served it locally, so in the offline trial its catch-all route
// refused the fetch and the page logged two console errors. Every spec that walks the router's pages and fails on a console error serves
// xterm.js locally, registered after its catch-all route so it answers first.
const dir = join(process.cwd(), 'browser-tests');

test('unit:e2e-ui-shell-all-pages-pinned — every spec that walks all dashboard pages and fails on console errors serves xterm.js locally', () => {
  const specs = readdirSync(dir).filter(name => name.endsWith('.spec.ts')).map(name => ({ name, spec: readFileSync(join(dir, name), 'utf8') }))
    .filter(({ spec }) => spec.includes('web/pages/index.tsx') && spec.includes("'no console errors'"));
  assert.ok(specs.some(({ name }) => name === 'ui-shell-all-pages.spec.ts'), 'ui-shell-all-pages is among the specs that walk the router');
  for (const { name, spec } of specs) {
    const served = spec.indexOf('serveXterm(');
    assert.ok(served >= 0, `${name} walks every page and serves xterm.js locally`);
    const catchAll = spec.indexOf("route('**/*'");
    assert.ok(catchAll < served, `${name} serves xterm.js after its catch-all route, so the local copy answers first`);
  }
});
