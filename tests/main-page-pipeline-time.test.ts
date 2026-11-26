import { test } from 'node:test';
import assert from 'node:assert/strict';

// GY-3527: the Work page's one sentence on how long an item takes from release to merge.
const now = Date.UTC(2026, 0, 1, 12, 0);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

test('unit:main-page-pipeline-time — the server reads the last 10 merges and the open item released longest ago', async () => {
  const { pipelineTime } = await import('../src/pipeline-speed.js');
  const merged = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, key: `GY-${index}`, title: 't', stage: 'done', delivery: { mergedAt: ago(index * 10) } }));
  const open = [{ id: 'o1', key: 'GY-20', title: 'Newer', stage: 'build' }, { id: 'o2', key: 'GY-21', title: 'Older', stage: 'review' }, { id: 'o3', key: 'GY-22', title: 'Backlog', stage: 'backlog' }];
  // Each merge took (index + 1) * 10 minutes; GY-10 and GY-11 are outside the last ten and took far longer.
  const released = new Map<string, number>([...merged.map((item, index) => [item.id, Date.parse(ago(index * 10)) - (index < 10 ? (index + 1) * 10 : 1000) * 60_000] as [string, number]),
    ['o1', Date.parse(ago(20))], ['o2', Date.parse(ago(50))], ['o3', Date.parse(ago(500))]]);
  const time = pipelineTime([...merged, ...open] as never, released, now);
  // Merges 0..110 minutes ago are all inside the last 24 hours.
  assert.deepEqual({ merged24h: time.merged24h, median: time.median, p90: time.p90, samples: time.samples }, { merged24h: 12, median: 50, p90: 90, samples: 10 });
  assert.equal(time.lastMergeAt, ago(0));
  assert.deepEqual(time.oldest, { id: 'o2', key: 'GY-21', title: 'Older', stage: 'review', releasedAt: ago(50) });
});
