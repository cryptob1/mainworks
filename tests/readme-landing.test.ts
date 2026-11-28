import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// GY-3925: README is the owner-approved front door; the walkthrough re-render steps stay in docs/walkthrough.md.
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('unit:tests/readme-landing.test.ts — README is the approved landing page naming AI coding agents, Claude Code and Codex, with its approved sections and no re-render commands', () => {
  const readme = read('README.md');
  const words = readme.trim().split(/\s+/).length;
  assert.ok(words <= 850, `README is at most 850 words: ${words}`);

  const lines = readme.split('\n');
  assert.equal(lines[0], '# Mainworks', 'README opens with an H1');
  const intro = lines.slice(2, 6).join(' ');
  for (const name of ['AI coding agents', 'Claude Code', 'Codex']) assert.ok(intro.includes(name), `the opening names ${name}`);

  const sections = [...readme.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(sections, ['Why this exists', 'What it looks like', 'How it works', 'Try it', 'How fast is it?', 'What to run it on', 'Is it safe to let agents do this?', 'Work with a factory from Slack', 'Learn more']);

  assert.doesNotMatch(readme, /render\.mjs|ffmpeg|makegif/, 'README carries no re-render commands');
  assert.ok(existsSync(new URL('docs/walkthrough.md', root)));
  const walkthrough = read('docs/walkthrough.md');
  for (const step of ['scripts/walkthrough/render.mjs', 'ffmpeg', 'scripts/walkthrough/makegif.py']) assert.ok(walkthrough.includes(step), `docs/walkthrough.md carries ${step}`);
});
