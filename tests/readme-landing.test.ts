import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// GY-3198: README is a short landing page; the walkthrough re-render steps live in docs/walkthrough.md.
// GY-3886 (re-land of GY-3873) raised the budget from 310 to 560 words and set the sections at the owner's request:
// "README that sells Mainworks: findable, attractive, and with a recommended server" — "One page, in this order:
// name and one-line promise, the walkthrough image, what it does in five short bullets, quick start, how it works
// in one diagram, what you need (with the server recommendation), and links."
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('unit:tests/readme-landing.test.ts — README is a short landing page naming AI coding agents, Claude Code and Codex, with What Mainworks does, Quick start, How it works, What you need and Where to go next sections', () => {
  const readme = read('README.md');
  const words = readme.trim().split(/\s+/).length;
  assert.ok(words <= 560, `README is at most 560 words: ${words}`);

  const [title, , pitch] = readme.split('\n');
  assert.equal(title, '# Mainworks', 'README opens with an H1');
  for (const name of ['AI coding agents', 'Claude Code', 'Codex']) assert.ok(pitch.includes(name), `the one-line value proposition names ${name}`);

  const sections = [...readme.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(sections, ['What Mainworks does', 'Quick start', 'How it works', 'What you need', 'Where to go next']);
  const how = readme.split('\n## How it works\n')[1]?.split('\n## ')[0] ?? '';
  assert.ok(how.trim().split(/\s+/).length < 100, 'the How it works section is six steps, the diagram and a pointer');

  const alt = readme.match(/!\[([^\]]*)\]\(docs\/diagrams\/how-mainworks-works\.gif\)/)?.[1] ?? '';
  assert.ok(alt.split(/\s+/).length >= 8, `the GIF has descriptive alt text: "${alt}"`);

  assert.match(readme, /\]\(docs\/walkthrough\.md\)/, 'README links the walkthrough re-render steps');
  assert.doesNotMatch(readme, /render\.mjs|ffmpeg|makegif/, 'README carries no re-render commands');
  assert.ok(existsSync(new URL('docs/walkthrough.md', root)));
  const walkthrough = read('docs/walkthrough.md');
  for (const step of ['scripts/walkthrough/render.mjs', 'ffmpeg', 'scripts/walkthrough/makegif.py']) assert.ok(walkthrough.includes(step), `docs/walkthrough.md carries ${step}`);
});
