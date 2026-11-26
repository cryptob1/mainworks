import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { masterStatusReport } from '../src/cli/master-status.js';
import { flowNumbers } from '../src/flow-numbers.js';
import { baseFailurePrefix } from '../src/model/merge-queue.js';
import { flowItems } from '../src/server/flow.js';
import { FlowLine } from '../web/pages/work.js';
import { adminToken, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';

// GY-3867 / GY-3870: the flow numbers list the five test files that most often failed a merge trial
// without passing on its rerun, with the latest occurrence's first failing assertion line.
const now = Date.parse('2026-11-25T12:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
let seq = 0;
const trial = (minutesAgo: number, failed: Record<string, string | null>, flaked: string[] = []) => ({ work_id: 'a', seq: ++seq, kind: 'merge.trial', created_at: at(minutesAgo), stage: null, head: `h${minutesAgo}`, duration_ms: 60_000,
  flaked: flaked.length > 0, trial: { flaked: flaked.length ? { files: flaked, tests: [], at: at(minutesAgo) } : null,
    failed: Object.keys(failed), assertions: Object.fromEntries(Object.entries(failed).filter(([, line]) => line)) } });

test('integration:trial-failures-grouped — test files that failed trials without passing on rerun are grouped: the top five by count, each with its latest assertion line', () => {
  const ledger = [
    trial(400, { 'tests/f1.test.ts': 'outside the window' }),
    trial(90, { 'tests/f1.test.ts': 'older line', 'tests/f2.test.ts': 'two' }),
    trial(80, { 'tests/f1.test.ts': 'newest line', 'tests/f3.test.ts': null, 'tests/f4.test.ts': 'four' }),
    trial(70, {}, ['tests/flaky.test.ts']),
    trial(60, { 'tests/f2.test.ts': 'two again', 'tests/f3.test.ts': null, 'tests/f4.test.ts': 'four' }),
    trial(50, { 'tests/f5.test.ts': 'five', 'tests/f4.test.ts': 'four' }, ['tests/flaky.test.ts']),
    trial(40, { 'tests/f5.test.ts': 'five', 'tests/f6.test.ts': 'six' }),
    trial(30, { 'tests/f1.test.ts': 'red base' }),
    { work_id: 'a', seq: ++seq, kind: 'merge.refused', created_at: at(29), stage: null, head: 'h30', reason: `${baseFailurePrefix} tests/f1.test.ts` },
  ];
  const items = flowItems([{ id: 'a', key: 'GY-1', title: 'Change', stage: 'test', stageEnteredAt: at(100) } as any], ledger, new Map(), new Map(), now);
  const flow = flowNumbers(items, 6, now);
  assert.deepEqual(flow.trialFailures, [
    { check: 'tests/f4.test.ts', count: 3, assertion: 'four' },
    { check: 'tests/f1.test.ts', count: 2, assertion: 'newest line' },
    { check: 'tests/f2.test.ts', count: 2, assertion: 'two again' },
    { check: 'tests/f3.test.ts', count: 2, assertion: null },
    { check: 'tests/f5.test.ts', count: 2, assertion: 'five' },
  ]);
  assert.deepEqual(flow.flakyChecks, [{ check: 'tests/flaky.test.ts', count: 2, assertion: null }]);
  const html = renderToStaticMarkup(createElement(FlowLine, { flow: { '6h': flow, '24h': flow, '7d': flow, attention: null, asOf: at(0), ageSeconds: 0 } }));
  assert.match(html, /data-trial-failures[^>]*>Failing checks: tests\/f4\.test\.ts 3 · tests\/f1\.test\.ts 2/);
});

test('e2e:trial-failures-grouped — with one failed trial, master status lists its check with its failing assertion line', { timeout: 280_000 }, async () => {
  const where = await pipelineWorld('trial-failures-grouped', {
    'package.json': JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs tests/*.test.cjs' } }),
  });
  try {
    const change = await where.submit('A change whose new test always fails', {
      'tests/broken.test.cjs': `const { test } = require('node:test');\ntest('tests/broken.test.cjs fails', () => { throw new Error('the change is broken'); });\n` });
    const loop = worldLoop(where, { gate: false, attribute: true });
    for (const start = Date.now(); ;) {
      await loop.cycle();
      const item = (await where.work()).find(work => work.id === change.id);
      if (item?.reworkRequested || item?.mergeLedger?.state === 'refused') break;
      assert.ok(Date.now() - start < 180_000, `${change.key} was not sent back: ${loop.lines.slice(-20).join('\n')}`);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const status = await masterStatusReport(where.root, where.config, async path => {
      if (path !== 'flow') return { work: await where.work(), now: new Date().toISOString() };
      const response = await fetch(`${where.url}/api/flow`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }, async () => { throw new Error('no git in the fixture'); });
    assert.ok(status.flow, `flow is shown (${status.flowError})`);
    assert.deepEqual(status.flow['6h'].trialFailures, [{ check: 'tests/broken.test.cjs', count: 1, assertion: 'the change is broken' }]);
  } finally { await where.close(); }
});
