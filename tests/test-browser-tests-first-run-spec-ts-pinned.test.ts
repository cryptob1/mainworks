import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3720: browser-tests/first-run.spec.ts failed on the batch gate and passed its re-run. After each change
// (clearing the fetch refusal, a failing then a passing live request) it clicked the step's button, but the page's
// own 5 s poll could answer first, advance the step and remove that button; the click then waited out 120 s
// (3 of 40 runs at 16 workers). The route now holds the page's replies from the change until the click lands.
test('unit:test-browser-tests-first-run-spec-ts-pinned — each step change holds the page\'s replies until its button is clicked', () => {
  const spec = readFileSync(join(process.cwd(), 'browser-tests/first-run.spec.ts'), 'utf8');
  assert.match(spec, /const response = await route\.fetch\([^\n]*\);\n\s*await held;\n\s*return await route\.fulfill\(\{ response \}\);/, 'replies wait while held');
  assert.match(spec, /held = new Promise[^\n]*\n\s*try \{\n\s*await change\(\);\n\s*await page\.getByRole\('button', \{ name: button \}\)\.click\(\);\n\s*\} finally \{\n\s*held = null;\n\s*release\(\);/, 'the hold spans the change and the click');
  assert.equal(spec.match(/clickBeforeReplies\(\(\) => api\(/g)?.length, 3, 'all three step changes click before replies');
  for (const button of ['Check connection', 'Refresh status']) {
    assert.ok(!spec.includes(`await page.getByRole('button', { name: '${button}' }).click();`), `${button} is never clicked after an unheld change`);
  }
});
