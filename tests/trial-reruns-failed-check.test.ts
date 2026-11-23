import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { cycleUntil, pipelineWorld, worldLoop, type World } from './helpers/pipeline-world.js';

// GY-3735: a merge trial reruns a failing test file once on the same tree, as the batch gate does.
// A file that passes its rerun is flaky: the trial is accepted and the batch gate's exact
// "Flaky check on main: test:FILE" item is filed, or reused while open. A file that fails both runs
// refuses the trial as before.

const title = 'Flaky check on main: test:tests/flaky.test.cjs';
// Fails once while `broken` names a marker path not yet written.
const flakyTest = `const { test } = require('node:test');
const fs = require('fs');
test('tests/flaky.test.cjs passes unless broken', () => {
  const marker = fs.existsSync('broken') ? fs.readFileSync('broken', 'utf8').trim() : '';
  if (marker && !fs.existsSync(marker)) { fs.writeFileSync(marker, ''); throw new Error('flaked'); }
});
`;
// Fails every run while `stuck` exists; it has no open flaky item, so nothing excuses it.
const steadyTest = "const { test } = require('node:test');\ntest('tests/steady.test.cjs passes unless stuck', () => { if (require('fs').existsSync('stuck')) throw new Error('fails every run'); });\n";
const world = () => pipelineWorld('trial-reruns-failed-check', {
  'package.json': JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs tests/flaky.test.cjs tests/steady.test.cjs' } }),
  'tests/flaky.test.cjs': flakyTest, 'tests/steady.test.cjs': steadyTest,
});
const flakyItems = async (where: World) => (await where.work()).filter(item => item.title === title);

async function mergesThroughFlake(where: World, loop: ReturnType<typeof worldLoop>, label: string) {
  const change = await where.submit(`A change the flaky test fails once on (${label})`, { broken: `${join(where.root, `flaked-${label}`)}\n` });
  await cycleUntil(loop, `${change.key} merges`, async () => (await where.work()).find(item => item.id === change.id)?.stage === 'done');
  const landed = (await where.work()).find(item => item.id === change.id)!;
  assert.equal(landed.reworkRequested, false, `${change.key} was not sent back`);
  assert.equal(landed.mergeLedger?.state, 'reconciled', JSON.stringify(landed.mergeLedger));
  return change;
}

test('integration:trial-reruns-failed-check — a test file failing once and passing its rerun merges and files (then reuses) the exact flaky item; failing both runs refuses', { timeout: 280_000 }, async () => {
  const where = await world();
  try {
    const loop = worldLoop(where, { gate: false, attribute: true });
    const first = await mergesThroughFlake(where, loop, 'one');
    const filed = await flakyItems(where);
    assert.equal(filed.length, 1, 'the flaky item is filed once');
    assert.notEqual(filed[0]!.stage, 'done', 'the flaky item is open');
    assert.equal(filed[0]!.faultKey, 'flake:test:tests/flaky.test.cjs');
    assert.match(filed[0]!.description, new RegExp(`tests/flaky\\.test\\.cjs failed in ${first.key}'s merge trial`));

    // While it is open, a second flake reuses it: a note, never a second item.
    const second = await mergesThroughFlake(where, loop, 'two');
    const reused = await flakyItems(where);
    assert.equal(reused.length, 1, 'the open flaky item is reused');
    const notes = (reused[0]!.agentRequests ?? []).filter(request => request.type === 'note');
    assert.ok(notes.some(request => request.reason.includes(`failed in ${second.key}'s merge trial`)), JSON.stringify(notes));

    // A file that fails its rerun too refuses the trial as before.
    const stuck = await where.submit('A change a steady test fails every run on', { stuck: 'yes\n' });
    await assert.rejects(cycleUntil(loop, `${stuck.key} is refused`, () => false), new RegExp(`${stuck.key} was refused: .*tests/steady\\.test\\.cjs`));
    assert.equal((await where.work()).find(item => item.id === stuck.id)?.stage === 'done', false, 'the failing change never merges');
  } finally { await where.close(); }
});

test('e2e:trial-reruns-failed-check — a trial with a test that fails once then passes merges the item and master status lists the flaky item', { timeout: 280_000 }, async () => {
  const where = await world();
  try {
    await mergesThroughFlake(where, worldLoop(where, { gate: false, attribute: true }), 'status');
    const report = await masterStatusReport(where.root, where.config, async () => ({ work: await where.work(), now: new Date().toISOString() }), async () => { throw new Error('no git in the fixture'); });
    assert.ok(report.items.some(item => item.title === title), JSON.stringify(report.items));
  } finally { await where.close(); }
});
