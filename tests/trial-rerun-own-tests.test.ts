import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { cycleUntil, pipelineWorld, worldLoop, type World } from './helpers/pipeline-world.js';

// GY-3759: a merge trial's rerun files "Flaky check on main" only for a test file main holds at the
// trial's base tip. A test file the item itself adds that fails once and passes its rerun is left to
// the item's own trial: nothing is filed for it. A file main holds still files the item as before.

// The shell expands the glob, so an item adds a test file without touching package.json (a sensitive delta).
const script = JSON.stringify({ name: 'pipeline-fixture', scripts: { build: 'node --eval 0', test: 'node --test --test-reporter=tap proof.cjs tests/*.test.cjs' } });
// Fails once while `broken` names a marker path not yet written: the first run writes it and throws, the rerun passes.
const ownTestFile = `const { test } = require('node:test');
const fs = require('fs');
test('tests/own.test.cjs passes on its rerun', () => {
  const marker = fs.existsSync('broken') ? fs.readFileSync('broken', 'utf8').trim() : '';
  if (marker && !fs.existsSync(marker)) { fs.writeFileSync(marker, ''); throw new Error('flaked'); }
});
`;
const world = () => pipelineWorld('trial-rerun-own-tests', { 'package.json': script, 'tests/main.test.cjs': "const { test } = require('node:test');\ntest('main passes', () => {});\n" });
const flakyItems = async (where: World) => (await where.work()).filter(item => item.title.startsWith('Flaky check on main'));

async function merges(where: World, loop: ReturnType<typeof worldLoop>, title: string, files: Record<string, string>) {
  const change = await where.submit(title, files);
  await cycleUntil(loop, `${change.key} merges`, async () => (await where.work()).find(item => item.id === change.id)?.stage === 'done');
  return change;
}

/** An item adding tests/own.test.cjs, which fails its first run in the trial and passes the rerun. */
const ownTest = (where: World) => ({ 'tests/own.test.cjs': ownTestFile, broken: `${join(where.root, 'own-flaked')}\n` });

test('integration:trial-rerun-own-tests — a branch-only test failing once files no flaky item; a test main holds still files one', { timeout: 280_000 }, async () => {
  const where = await world();
  try {
    const loop = worldLoop(where, { gate: false, attribute: true });
    await merges(where, loop, 'A change adding its own test that fails once', ownTest(where));
    assert.deepEqual((await flakyItems(where)).map(item => item.title), [], 'no flaky item for a test main lacks');

    // tests/own.test.cjs is on main now: a later flake of it files the item as before.
    await merges(where, loop, 'A change main\'s own test fails once on', { broken: `${join(where.root, 'main-flaked')}\n` });
    const filed = await flakyItems(where);
    assert.deepEqual(filed.map(item => item.title), ['Flaky check on main: test:tests/own.test.cjs']);
    assert.equal(filed[0]!.faultKey, 'flake:test:tests/own.test.cjs');
  } finally { await where.close(); }
});

test('e2e:trial-rerun-own-tests — an item whose own new test fails once then passes leaves no flaky item in master status', { timeout: 280_000 }, async () => {
  const where = await world();
  try {
    await merges(where, worldLoop(where, { gate: false, attribute: true }), 'A change adding its own test that fails once', ownTest(where));
    const report = await masterStatusReport(where.root, where.config, async () => ({ work: await where.work(), now: new Date().toISOString() }), async () => { throw new Error('no git in the fixture'); });
    assert.deepEqual(report.items.filter(item => item.title.startsWith('Flaky check on main')).map(item => item.title), []);
  } finally { await where.close(); }
});
