import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// GY-3918: GY-3903 refactored scratch Git repos in trial tests onto ./helpers/git-repo.js, which
// imports ./temp-dirs.js at top level and therefore isolates every test file that imports it. The
// static isolation guard in tests/heavy-slot-test-isolation.test.ts only matched a hardcoded pair
// of helper names (temp-dirs|pipeline-world) instead of following helper imports to temp-dirs.ts,
// turning main red on hard-math-process.test.ts, loop-adopts-release-under-trials.test.ts and
// trial-survives-loop-restart.test.ts.
const root = join(import.meta.dirname, '..');

test('unit:heavy-slot-test-isolation-pinned — the trial-isolation guard follows transitive helper imports to temp-dirs.ts and passes on git-repo.js callers', { timeout: 30_000 }, () => {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-name-pattern=every test file that starts trials is isolated', 'tests/heavy-slot-test-isolation.test.ts'],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.match(output, /pass 1/, 'the isolation guard test executed and passed');
  assert.match(output, /fail 0/, 'no isolation guard failure');
});
