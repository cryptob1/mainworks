import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
let report: { status: number | null; output: string } | undefined;
function knip() {
  if (!report) {
    const run = spawnSync(process.execPath, ['node_modules/knip/bin/knip.js', '--no-progress', '--no-config-hints'], { cwd: root, encoding: 'utf8', timeout: 300_000 });
    report = { status: run.status, output: `${run.stdout}${run.stderr}` };
  }
  return report;
}

// GY-3726: knip (knip.json names the entry points) finds unused files, exports and dependencies; any report fails.
test('unit:knip-clean — knip reports no unused files, exports or dependencies', () => {
  // GY-3964: tests are no entry points, so code only tests use is reported.
  assert.doesNotMatch(readFileSync(join(root, 'knip.json'), 'utf8'), /"(?:browser-)?tests\//, 'knip.json names no test file');
  const { status, output } = knip();
  assert.equal(status, 0, `knip reported unused code:\n${output}`);
});

// GY-3815: the scheduled run on main found these exported only for deleted tests, and the flock system binary unlisted.
test('unit:knip-clean-pinned — the exports and binary main reported stay unreported', () => {
  const names = ['flock', 'setGateNote', 'registryHelp', 'deployReleaseKey', 'deployReleaseGraceMs', 'signoffWakeRepeatMs', 'emptyBoardWakeRepeatMs',
    'signoffWaitingItems', 'emptyBoardMinFreeSlots', 'emptyBoardIdleMs', 'quietUpdateMs', 'forcedUpdateMs', 'downtimeRenewalWindowMs', 'eventHistoryTimeoutMs',
    'olderTrialVerbs', 'startCaretakerProbeServer', 'warmCompileCacheDirectory', 'warmDistDirectory', 'warmCommitFile', 'parseWarmImageTag',
    'ensureWarmImageV1', 'selectWarmImage', 'revertStartMs', 'piKeyEnvironment', 'DiagnosticsRun'];
  const { output } = knip();
  assert.deepEqual(names.filter(name => new RegExp(`^${name}\\s`, 'm').test(output)), [], `knip reported:\n${output}`);
});

// GY-4039: a deploy test builds its ports on tests/helpers/deploy-ports.ts and names only what its case varies.
test('unit:knip-clean — no test file spells a DeployWatchPorts object inline', () => {
  const inline = readdirSync(join(root, 'tests'), { recursive: true, encoding: 'utf8' }).filter(path => /\.test\.ts$/.test(path) && /DeployWatchPorts\s*=\s*\{|:\s*DeployWatchPorts\s*=>\s*\(\{/.test(readFileSync(join(root, 'tests', path), 'utf8')));
  assert.deepEqual(inline, [], 'test files that still spell their deploy-watch ports inline');
});
