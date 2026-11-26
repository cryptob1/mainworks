import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, cycleUntil, pipelineWorld, worldLoop } from './helpers/pipeline-world.js';

// GY-3545, GY-3881: the real loop's merge writer over a real trial. With an open "Flaky check on main"
// item for tests/flaky.test.cjs, a candidate that breaks that test while the base tip passes it is
// refused naming the file: an open flaky item never excuses a candidate's own failure.

const flakyTest = "const { test } = require('node:test');\ntest('tests/flaky.test.cjs fails while broken exists', () => { if (require('fs').existsSync('broken')) throw new Error('flaked'); });\n";

test('e2e:trial-known-flaky — a candidate that breaks a test with an open flaky item, while the base tip passes it, is refused naming the file', { timeout: 280_000 }, async () => {
  const world = await pipelineWorld('trial-known-flaky', {
    'package.json': JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs tests/flaky.test.cjs' } }),
    'tests/flaky.test.cjs': flakyTest,
  });
  try {
    const filed = await fetch(`${world.url}/api/work`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'flake:test:tests/flaky.test.cjs' },
      body: JSON.stringify({ title: 'Flaky check on main: test:tests/flaky.test.cjs', why: 'w', simplest: 's', type: 'bug', criteria: [{ id: 'AC-1', text: 'Deterministic', proofs: ['unit:flaky-pinned', 'e2e:fixture'] }] }) });
    const flaky = (await filed.json()) as { key: string; id: string };
    assert.ok(filed.ok, JSON.stringify(flaky));

    const change = await world.submit('A change the flaky test fails on', { broken: 'yes\n' });
    const loop = worldLoop(world, { gate: false });
    const refusal = async () => (await world.work()).find(item => item.id === change.id)?.mergeLedger?.refusal?.reason ?? '';
    await cycleUntil(loop, `${change.key} is refused`, async () => !!(await refusal()));
    assert.match(await refusal(), /tests\/flaky\.test\.cjs/);
    const work = await world.work();
    assert.notEqual(work.find(item => item.id === change.id)!.stage, 'done', 'the candidate did not land');
    const notes = (work.find(item => item.key === flaky.key)!.agentRequests ?? []).filter(request => request.type === 'note' && request.reason.includes(`${change.key}'s merge trial`));
    assert.equal(notes.length, 0, 'the flaky item excused nothing');
  } finally { await world.close(); }
});
