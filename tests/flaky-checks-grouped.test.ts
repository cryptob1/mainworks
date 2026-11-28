import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as batchGate from '../src/batch-gate.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { flowNumbers } from '../src/flow-numbers.js';
import * as executor from '../src/merge-writer/executor.js';
import { flowItems } from '../src/server/flow.js';
import { FlowLine } from '../web/pages/work.js';
import { adminToken, cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';

// GY-3849: the flow numbers list the five test files that most often failed a trial or release check
// and passed on rerun, with the latest occurrence's first failing assertion line.
const now = Date.parse('2026-11-25T12:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
let seq = 0;
const trial = (minutesAgo: number, flaked: Record<string, string | null> | null) => ({ work_id: 'a', seq: ++seq, kind: 'merge.trial', created_at: at(minutesAgo), stage: null, head: `h${minutesAgo}`, duration_ms: 60_000, flaked: !!flaked,
  flakes: flaked && { files: Object.keys(flaked), tests: [], at: at(minutesAgo), assertions: Object.fromEntries(Object.entries(flaked).filter(([, line]) => line)) } });

test('integration:flaky-checks-grouped — rerun-passed test files of the window are grouped: the top five by count, each with its latest assertion line', () => {
  const ledger = [
    trial(400, { 'tests/f1.test.ts': 'outside the window' }),
    trial(90, { 'tests/f1.test.ts': 'older line', 'tests/f2.test.ts': 'two' }),
    trial(80, { 'tests/f1.test.ts': 'newest line', 'tests/f3.test.ts': null, 'tests/f4.test.ts': 'four' }),
    trial(70, null),
    trial(60, { 'tests/f2.test.ts': 'two again', 'tests/f3.test.ts': null, 'tests/f4.test.ts': 'four' }),
    trial(50, { 'tests/f5.test.ts': 'five', 'tests/f4.test.ts': 'four' }),
    trial(40, { 'tests/f5.test.ts': 'five', 'tests/f1.test.ts': 'f1 last in a trial' }),
    trial(30, { 'tests/f6.test.ts': 'six' }),
  ];
  const items = flowItems([{ id: 'a', key: 'GY-1', title: 'Change', stage: 'test', stageEnteredAt: at(100) } as any], ledger, new Map(), new Map(), now);
  const flow = flowNumbers(items, 6, now, [{ file: 'tests/f1.test.ts', at: at(10), assertion: 'release check line' }, { file: 'tests/f6.test.ts', at: at(500), assertion: 'old' }]);
  assert.deepEqual(flow.flakyChecks, [
    { check: 'tests/f1.test.ts', count: 4, assertion: 'release check line', lastFailedAt: at(10) },
    { check: 'tests/f4.test.ts', count: 3, assertion: 'four', lastFailedAt: at(50) },
    { check: 'tests/f2.test.ts', count: 2, assertion: 'two again', lastFailedAt: at(60) },
    { check: 'tests/f3.test.ts', count: 2, assertion: null, lastFailedAt: at(60) },
    { check: 'tests/f5.test.ts', count: 2, assertion: 'five', lastFailedAt: at(40) },
  ]);
  const html = renderToStaticMarkup(createElement(FlowLine, { flow: { '6h': flow, '24h': flow, '7d': flow, attention: null, onboarding: [], asOf: at(0), ageSeconds: 0 } }));
  assert.match(html, /data-flaky-checks[^>]*>Flaky checks: tests\/f1\.test\.ts 4 · tests\/f4\.test\.ts 3/);
});

test('integration:flaky-checks-grouped — each failing file of a trial\'s TAP keeps its own first assertion line', () => {
  const entry = (name: string, file: string, error: string, indent = '') => [`not ok 1 - ${name}`, '  ---', `  location: '/checkout/${file}:3:1'`, ...error.split('\n'), '  ...'].map(line => indent + line).join('\n');
  const tap = [entry('inner', 'tests/a.test.ts', "  error: '1 == 2'", '    '), entry('outer', 'tests/a.test.ts', "  error: '1 subtest failed'"),
    entry('b', 'tests/b.test.ts', '  error: |-\n    Expected values to be equal:\n    \n    3 !== 4'), entry('other', 'tests/c.test.ts', "  error: 'unasked'")].join('\n');
  assert.deepEqual(executor.assertionsByFile(tap, ['tests/a.test.ts', 'tests/b.test.ts']), { 'tests/a.test.ts': '1 == 2', 'tests/b.test.ts': 'Expected values to be equal:' });
});

test('integration:flaky-checks-grouped — a release check records each test file its rerun, or its trial\'s own rerun, passed', async () => {
  const tip = 'b'.repeat(40), seen = { assertions: {} as Record<string, string>, flaked: new Set<string>() };
  let runs = 0;
  const ports: batchGate.GatePorts = {
    now: () => Date.now(), fetch: async () => tip, landings: async () => [], files: async () => ['tests/a.test.ts'], catalog: async () => [], core: async () => [],
    seen,
    run: async () => {
      if (++runs > 1) return [];
      Object.assign(seen.assertions, { 'tests/a.test.ts': 'a line', 'tests/b.test.ts': 'b line' });
      seen.flaked.add('tests/b.test.ts');
      return ['test:tests/a.test.ts'];
    },
    revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }),
  };
  const record = batchGate.bootstrapGate('owner/project', 'a'.repeat(40));
  assert.equal((await batchGate.runGate(ports, record)).outcome, 'verified');
  assert.deepEqual(record.flakes?.map(({ file, assertion }) => ({ file, assertion })), [{ file: 'tests/b.test.ts', assertion: 'b line' }, { file: 'tests/a.test.ts', assertion: 'a line' }]);
});

test('e2e:flaky-checks-grouped — with one rerun-passed trial, master status lists that check with its failing assertion line', { timeout: 280_000 }, async () => {
  const where = await pipelineWorld('flaky-checks-grouped', {
    'package.json': JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs tests/flaky.test.cjs' } }),
    // Fails once while `broken` names a marker path not yet written.
    'tests/flaky.test.cjs': `const { test } = require('node:test');
const fs = require('fs');
test('tests/flaky.test.cjs passes unless broken', () => {
  const marker = fs.existsSync('broken') ? fs.readFileSync('broken', 'utf8').trim() : '';
  if (marker && !fs.existsSync(marker)) { fs.writeFileSync(marker, ''); throw new Error('the marker was not written'); }
});
` });
  try {
    const change = await where.submit('A change a flaky test fails once on', { broken: `${join(where.root, 'flaked')}\n` });
    await cycleUntil(worldLoop(where, { gate: false, attribute: true }), `${change.key} merges`, async () => (await where.work()).find(item => item.id === change.id)?.stage === 'done');
    const status = await masterStatusReport(where.root, where.config, async path => {
      if (path !== 'flow') return { work: await where.work(), now: new Date().toISOString() };
      const response = await fetch(`${where.url}/api/flow`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    }, async () => { throw new Error('no git in the fixture'); });
    assert.ok(status.flow, `flow is shown (${status.flowError})`);
    const [{ lastFailedAt, ...flaky }] = status.flow['6h'].flakyChecks;
    assert.deepEqual([flaky], [{ check: 'tests/flaky.test.cjs', count: 1, assertion: 'the marker was not written' }]);
    assert.ok(Math.abs(Date.now() - Date.parse(lastFailedAt!)) < 280_000, `lastFailedAt is when the release check flaked: ${lastFailedAt}`);
  } finally { await where.close(); }
});
