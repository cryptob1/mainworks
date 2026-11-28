import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// 2026-09-26: integration:instant-exit-classified fed a stub runtime the notice "resets 2026-09-26T07:00:00Z"
// and ran it against the real clock. Once that hour passed, the reset was in the past, the account was no
// longer held, and every candidate's required CI check failed on a test none of them touched.

const notice = /(?:hit your weekly limit · resets|quota will reset at) 20\d{2}-\d{2}-\d{2}|\breset\w*\s*=\s*'20\d{2}-\d{2}-\d{2}/i;

async function offenders(only?: string) {
  const dir = join(process.cwd(), 'tests');
  const found: string[] = [];
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.ts') && (!only || name === only))) {
    const lines = (await readFile(join(dir, file), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (notice.test(line) && !/,\s*now\)|\bnow\s*=\s*Date\.parse\(/.test(line) && !line.includes('no-dated-limit-notices')) found.push(`${file}:${index + 1}`);
    });
  }
  return found;
}

test('unit:no-dated-limit-notices — a provider limit notice in a test names a fixed date only where the test also fixes the clock', async () => {
  assert.deepEqual(await offenders(), [], 'compute the reset from Date.now() (as tests/auto-dispatch.test.ts does), or pass a fixed now to detectExhaustion');
});

// GY-4091: the GitHub rate-limit stand-in named a fixed reset (2030) while the loop read it on the real clock.
test('unit:no-dated-limit-notices-pinned — the GitHub rate-limit stand-in computes its reset from the clock', async () => {
  assert.deepEqual(await offenders('github-calls-counted-and-bounded.test.ts'), []);
});
