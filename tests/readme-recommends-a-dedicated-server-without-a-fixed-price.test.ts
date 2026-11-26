import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3873: the README's What you need recommends a dedicated server in at most eight lines, with the
// measured reason, a named fit linked to Hetzner's own page, a price range and no fixed price.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('unit:readme-recommends-a-dedicated-server-without-a-fixed-price — What you need recommends a dedicated Hetzner AX server with 64 GB, gives the measured throttling reason and a price range, adds machines with host add, and disclaims affiliation', () => {
  const section = readme.split('\n## What you need\n')[1]?.split('\n## ')[0] ?? '';
  const hardware = section.trim().split('\n\nPrerequisites')[0]!;
  const lines = hardware.split('\n');
  assert.ok(lines.length >= 4 && lines.length <= 8, `the hardware recommendation is at most eight lines: ${lines.length}`);
  assert.match(hardware, /dedicated server rather than a shared virtual one/);
  assert.match(hardware, /Shared CPUs get throttled: [^\n]*\b70% CPU steal\b[^\n]*\./, 'one sentence gives the reason with our measured example');
  assert.match(hardware, /\[Hetzner dedicated server\]\(https:\/\/www\.hetzner\.com\/dedicated-rootserver\/?\)/, 'links Hetzner\'s dedicated-server page');
  assert.match(hardware, /\bAX line\b[^\n]*\b64 GB RAM\b/);
  assert.ok(hardware.includes('roughly 50 to 110 US dollars a month, check the current price'));
  assert.doesNotMatch(readme, /[$€£]\s?\d|\d\s?(?:USD|EUR|€)|\b\d+(?:\.\d+)? (?:US )?(?:dollars|euros)\b(?! a month, check)/, 'no fixed price');
  assert.match(hardware, /more machines for tests later with one command: `mainworks host add`/);
  assert.match(hardware, /Mainworks has no affiliation with Hetzner\./);
});
