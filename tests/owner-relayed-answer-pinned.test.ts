import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// GY-3654: tests/owner-relayed-answer.test.ts failed on main and passed on its re-run. It set
// location.hash right after the Work heading painted, but the dashboard follows hash changes from an
// effect that may not have run by then, so a missed change left the page on Work. Since GY-3599 its
// History fold also sits under the item page's Details tab, which the test never opened.

test('unit:owner-relayed-answer-pinned — the relayed-answer e2e opens Needs you by loading its address and opens the Details tab before History', async () => {
  const text = await readFile(new URL('./owner-relayed-answer.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /location\.hash\s*=/, 'setting location.hash races the dashboard\'s hashchange listener; load the address with page.goto');
  assert.match(text, /page\.goto\(`\$\{url\}\/#needs-you`\)/, 'Needs you is opened by loading its address');
  const tab = text.indexOf("getByRole('tab', { name: 'Details'"), history = text.indexOf('hasText: /^History/');
  assert.ok(tab > 0 && tab < history, 'the Details tab is opened before the History fold is clicked');
});
