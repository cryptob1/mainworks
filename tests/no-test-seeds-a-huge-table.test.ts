import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// GY-3792: four tests seeding two million events took four minutes each and tripped the release
// check. A test proves plans, rows and bounds on a small table; the large-table timings live in `bench reads`.
const LIMIT = 200_000;
const seeds = /\b[A-Z_]*(?:EVENTS|ROWS)\s*=\s*([\d_]+)|generate_series\(\s*1\s*,\s*([\d_]+)\s*\)/g;

function seededCounts(source: string): number[] {
  return [...source.matchAll(seeds)].map(match => Number((match[1] ?? match[2]).replaceAll('_', '')));
}

test('unit:no-test-seeds-a-huge-table — no test file seeds more than 200,000 rows', () => {
  // Split so this file does not match its own pattern.
  assert.deepEqual(seededCounts('const ITEMS = 2000, EVENTS' + ' = 2_000_000; generate_series(1, ' + '300000)'), [2_000_000, 300_000]);
  const files = readdirSync('tests', { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.test.ts'));
  assert.ok(files.length > 100);
  const huge = files.flatMap(file => seededCounts(readFileSync(join('tests', file), 'utf8')).filter(count => count > LIMIT).map(count => `${file}: ${count}`));
  assert.deepEqual(huge, [], 'seed at most 200,000 rows; time large tables with `mainworks bench reads`');
});
