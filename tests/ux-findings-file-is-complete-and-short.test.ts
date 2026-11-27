import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GY-3962: docs/ux-findings.md lists, per page, every place that breaks the UX standard, one row each:
// where, what a newcomer sees, which rule, a severity of 1, 2 or 3, and whether it was fixed. It stays
// under 150 lines, the captures come from one committed command, and no severity-1 finding is left open.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('unit:ux-findings-file-is-complete-and-short — every page has its findings, one row each with where, what, rule and severity, in at most 150 lines', () => {
  const text = read('docs/ux-findings.md');
  const lines = text.split('\n');
  assert.ok(lines.length <= 150, `docs/ux-findings.md is ${lines.length} lines`);
  assert.match(text, /npm run ux:captures/, 'it names the command its captures came from');
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.scripts['ux:captures'], 'node scripts/ux-captures.mjs', 'the capture command is committed');
  const script = read('scripts/ux-captures.mjs');
  assert.match(script, /for \(const width of \[390, 1280\]\)/, 'it captures at 390 and 1280 px');
  assert.match(script, /scripts\/docs-media-demo\.mjs|demo-server\.mjs/, 'from the demo data');

  const sections = new Map<string, string[]>();
  let current = '';
  for (const line of lines) {
    if (line.startsWith('## ')) { current = line.slice(3).trim(); sections.set(current, []); continue; }
    if (current && line.startsWith('| ') && !/^\| (?:Where|---)/.test(line)) sections.get(current)!.push(line);
  }
  const pages = ['Home', 'Work', 'A change: Checks and diff', 'A change: Live session, Lead, Details', 'Lead: Conversation, Live session, History, Product',
    'Settings', 'Setup', 'Sign-in', 'Empty first run', 'Error state'];
  for (const page of pages) {
    const heading = [...sections.keys()].find(name => name.startsWith(page));
    assert.ok(heading, `a section for ${page}`);
    assert.ok(sections.get(heading!)!.length > 0, `${page} lists its findings`);
  }
  // Each Settings page is named in the Settings rows.
  const settings = sections.get('Settings')!.join('\n');
  for (const name of ['Agents', 'Workers', 'Costs', 'Setup', 'Delivery', 'Help']) assert.match(settings, new RegExp(`^\\| ${name} \\|`, 'm'), `Settings names ${name}`);

  const rules = new Set(['plain', 'next', 'internal', 'error', 'twice', 'fit']);
  const rows = [...sections.values()].flat();
  let fixed = 0;
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
    assert.equal(cells.length, 5, `five cells: ${row}`);
    const [where, sees, rule, severity, status] = cells;
    assert.ok(where && sees.length >= 10, `where and what a newcomer sees: ${row}`);
    assert.ok(rules.has(rule), `a rule of the standard: ${row}`);
    assert.match(severity, /^[123]$/, `severity 1, 2 or 3: ${row}`);
    assert.match(status, /^(?:Fixed|Open)$/, `fixed or open: ${row}`);
    if (status === 'Fixed') fixed++;
    assert.ok(!(severity === '1' && status === 'Open'), `no severity-1 finding is left open: ${row}`);
  }
  assert.ok(fixed >= 10, `at least ten findings fixed: ${fixed}`);
});
