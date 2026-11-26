import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDateVersions, datedVersionPattern } from '../src/release.js';

// GY-1959: every candidate production promotes becomes a dated release on the stable channel.

test('unit:release-version — date versions take YYYY.M.D and .N suffixes without leading zeros, and the latest sorts last', () => {
  for (const version of ['2026.10.17', '2026.10.17.1', '2026.1.5']) assert.match(version, datedVersionPattern);
  for (const other of ['0.1.0x', 'v2026.10.17', '2026.10.17.0', 'stable', 'unreleased abc']) assert.doesNotMatch(other, datedVersionPattern);
  assert.deepEqual(['2026.10.17.1', '2026.9.30', '2026.10.17', '2026.10.17.10', '2026.10.17.2'].sort(compareDateVersions),
    ['2026.9.30', '2026.10.17', '2026.10.17.1', '2026.10.17.2', '2026.10.17.10']);
});
