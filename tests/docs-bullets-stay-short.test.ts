import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3940: the getting-started guide and the reference say one idea per bullet; none runs over 40 words.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('unit:docs-bullets-stay-short — no bullet or numbered step in docs/setup.md or docs/reference.md is over 40 words', () => {
  let checked = 0;
  for (const file of ['docs/setup.md', 'docs/reference.md']) {
    for (const line of read(file).split('\n').filter(line => /^(?:- |\d+\. )/.test(line))) {
      const words = line.replace(/^(?:- |\d+\. )/, '').trim().split(/\s+/).length;
      assert.ok(words <= 40, `${file} has a ${words}-word bullet: ${line}`);
      checked++;
    }
  }
  assert.ok(checked >= 40, `bullets checked: ${checked}`);
});
