import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean));

function relativeLinks(markdown: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push(match[1]!);
  for (const match of markdown.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) found.push(match[1]!);
  return found
    .filter(target => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target))
    .map(target => target.split(/[?#]/, 1)[0]!)
    .filter(Boolean);
}

test('unit:docs-links-resolve — every relative link and image path in README.md and docs/*.md resolves to a tracked file, and the renamed walkthrough media and updated where-things-run diagram exist', () => {
  const markdownFiles = [
    'README.md',
    ...readdirSync(resolve(root, 'docs'))
      .filter(name => name.endsWith('.md'))
      .sort()
      .map(name => posix.join('docs', name)),
  ];

  let checked = 0;
  for (const file of markdownFiles) {
    const content = readFileSync(resolve(root, file), 'utf8');
    for (const target of relativeLinks(content)) {
      const resolved = relative(root, resolve(root, dirname(file), target)).split('\\').join('/');
      assert.ok(tracked.has(resolved), `${file} links to ${target} (${resolved}), which is not a tracked file`);
      checked++;
    }
  }
  assert.ok(checked >= 5, `expected at least 5 relative links checked, got ${checked}`);

  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  const walkthrough = readFileSync(resolve(root, 'docs/walkthrough.md'), 'utf8');
  for (const media of ['docs/diagrams/how-mainworks-works.gif', 'docs/diagrams/how-mainworks-works.mp4']) {
    assert.ok(tracked.has(media), `${media} is tracked`);
    assert.ok(readme.includes(media), `README.md links ${media}`);
    assert.ok(walkthrough.includes(media), `docs/walkthrough.md outputs ${media}`);
  }
  assert.doesNotMatch(readme, /how-graphyard-works/, 'README.md has no old walkthrough filename');
  assert.doesNotMatch(walkthrough, /how-graphyard-works/, 'docs/walkthrough.md has no old walkthrough filename');

  const svg = readFileSync(resolve(root, 'docs/diagrams/where-things-run.svg'), 'utf8');
  assert.match(svg, /coordinator/i, 'where-things-run.svg shows the coordinator');
  assert.match(svg, /compute machine/i, 'where-things-run.svg shows compute machines');
  assert.match(svg, /caretaker/i, 'where-things-run.svg shows the caretaker');
});
