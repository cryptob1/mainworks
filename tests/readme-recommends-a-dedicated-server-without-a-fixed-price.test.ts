import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3925 (updating GY-3886): the README's What to run it on recommends a dedicated server
// with the measured throttling reason, a named fit linked to Hetzner's own page, a price range
// with no fixed price, adding machines with host add, and an affiliation disclaimer.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('unit:readme-recommends-a-dedicated-server-without-a-fixed-price — What to run it on recommends a dedicated Hetzner AX server with 64 GB, gives the measured throttling reason and a price range, adds machines with host add, and disclaims affiliation', () => {
  const section = readme.split('\n## What to run it on\n')[1]?.split('\n## ')[0]?.trim() ?? '';
  assert.ok(section.length > 0, 'README has a What to run it on section');
  assert.match(section, /dedicated server, not a shared virtual one/);
  assert.match(section, /Shared CPUs get throttled[^\n]*60 to 75 percent of its CPU[^\n]*\./, 'gives the reason with our measured example');
  assert.match(section, /\[Hetzner dedicated server\]\(https:\/\/www\.hetzner\.com\/dedicated-rootserver\/?\)/, 'links Hetzner\'s dedicated-server page');
  assert.match(section, /\bAX line\b[^\n]*\b64 GB RAM\b/);
  assert.ok(section.includes('roughly 50 to 110 US dollars a month; check the current price'));
  assert.doesNotMatch(readme, /[$€£]\s?\d|\d\s?(?:USD|EUR|€)|\b\d+(?:\.\d+)? (?:US )?(?:dollars|euros)\b(?! a month; check)/, 'no fixed price');
  assert.match(section, /mainworks host add/);
  assert.match(section, /no affiliation with Hetzner\./i);
});
