import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3360: every fact cut from the README lives in docs/setup.md, which the README links.
// GY-3873 raised the budget from 290 to 560 words at the owner's request: "README that sells Mainworks:
// findable, attractive, and with a recommended server" — "One page, in this order: name and one-line promise,
// the walkthrough image, what it does in five short bullets, quick start, how it works in one diagram, what you
// need (with the server recommendation), and links."
const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const moved = [
  'on an AppArmor host up loads the `mainworks-trial` profile with sudo',
  'Workers and reviewers run headless, logged per item (`mainworks guide runtimes`)',
  'Where a SAML organization or org policy blocks deploy keys, `--push-auth gh` pushes with your gh login instead of a deploy key',
  'Setup invites or revokes viewers and maintainers',
  'Verified deploys publish `@cryptob1/graphyard` with npm OIDC provenance plus both GHCR images via Actions — no host publish token',
];

test('e2e:readme-landing-budget — README is at most 560 words, links the setup guide, and the guide carries every fact moved out of the README', () => {
  const readme = read('README.md');
  const words = readme.trim().split(/\s+/).length;
  assert.ok(words <= 560, `README is at most 560 words: ${words}`);
  assert.match(readme, /\]\(docs\/setup\.md\)/, 'README links docs/setup.md');
  const guide = read('docs/setup.md');
  for (const fact of moved) assert.ok(guide.includes(fact), `docs/setup.md carries: ${fact}`);
});

test('unit:readme-landing-budget-pinned — the owner-relay fact (GY-1857 answers through any agent) lives in the setup guide the README links, and the README fits its budget', () => {
  const readme = read('README.md');
  assert.match(read('docs/setup.md'), /Tell any agent; reverse relayed answers under Needs you\./, 'the setup guide says any agent relays the owner answer and Needs you reverses it');
  assert.ok(readme.trim().split(/\s+/).length <= 560, 'README stays at most 560 words with the relay fact');
});
