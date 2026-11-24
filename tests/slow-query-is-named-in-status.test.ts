import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordQuery, slowestQuery } from '../src/store/slow-queries.js';
import { slowQueryAttention } from '../src/cli/master-status.js';

// GY-3757: master status names the slowest database query of the last 10 minutes when it ran past 3 s.
test('unit:slow-query-is-named-in-status — the slowest query past 3 s in the last 10 minutes is named in master status; faster or older ones are not', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  assert.deepEqual(slowQueryAttention(slowestQuery(now), now), [], 'nothing slow, nothing shown');
  recordQuery('SELECT 1', 2_900, now - 60_000);
  assert.equal(slowestQuery(now), null, 'under 3 s is not reported');
  recordQuery('SELECT seq FROM events\n   WHERE work_id=$1 ORDER BY seq DESC', 9_000, now - 11 * 60_000);
  recordQuery('SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.key = $1', 4_200, now - 3 * 60_000);
  recordQuery('SELECT count(*) FROM jobs', 3_500, now - 60_000);
  const slowest = slowestQuery(now);
  assert.equal(slowest?.name, 'SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.key = $1', 'the 9 s query fell out of the 10-minute window');
  const [line] = slowQueryAttention(slowest, now);
  assert.equal(line.subject, 'database');
  assert.equal(line.text, 'The slowest database query of the last 10 minutes took 4.2 s, 3m ago: SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.key = $1');
  assert.equal(slowestQuery(now + 10 * 60_000), null, 'ten minutes later it is gone');
});
