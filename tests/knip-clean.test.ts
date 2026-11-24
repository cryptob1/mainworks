import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// GY-3726: knip (knip.json names the entry points) finds unused files, exports and dependencies; any report fails.
test('unit:knip-clean — knip reports no unused files, exports or dependencies', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const knip = spawnSync(process.execPath, ['node_modules/knip/bin/knip.js', '--no-progress', '--no-config-hints'], { cwd: root, encoding: 'utf8', timeout: 300_000 });
  assert.equal(knip.status, 0, `knip reported unused code:\n${knip.stdout}${knip.stderr}`);
});
