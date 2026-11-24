import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startPostgres } from './helpers/postgres.js';

const files = [
  'tests/flow-ledger-fast.test.ts',
  'tests/item-status-read-is-indexed-and-bounded.test.ts',
  'tests/backfill-stage-small-batches.test.ts',
];

const root = fileURLToPath(new URL('..', import.meta.url));

function runTestFile(file: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    child.stdout.on('data', chunk => chunks.push(String(chunk)));
    child.stderr.on('data', chunk => chunks.push(String(chunk)));
    child.on('close', code => resolve({ code, output: chunks.join('') }));
  });
}

// Running all three 2M-row database test files three times in a row under a two-core CPU burner
// takes ~10-20 minutes on a loaded host, past CI shards' and merge trials' 5-minute file bound
// (GRAPHYARD_FILE_TIMEOUT_MS, tests/helpers/bounded-tests.mjs). Those runners defer to the proof
// producer, which runs the file without a file-timeout bound (slow-tick-repeat-receipt.test.ts).
const deferred = process.env.SHARD
  ? 'a CI shard leaves the 3x CPU-burned execution to the proof producer'
  : Number(process.env.GRAPHYARD_FILE_TIMEOUT_MS ?? Infinity) < 1_800_000
    ? `a runner bounding this file at ${process.env.GRAPHYARD_FILE_TIMEOUT_MS} ms leaves the 3x CPU-burned execution to the proof producer`
    : false;

test('unit:db-speed-tests-assert-plans-static — none of the three database speed tests uses performance.now() and each asserts EXPLAIN (ANALYZE, BUFFERS)', async () => {
  const helper = await readFile(new URL('./helpers/query-plan.ts', import.meta.url), 'utf8');
  assert.match(helper, /EXPLAIN\s*\(\s*ANALYZE\s*,\s*BUFFERS/i, 'query-plan helper must run EXPLAIN (ANALYZE, BUFFERS)');
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bperformance\.now\s*\(/, `${file} still contains performance.now()`);
    assert.match(source, /\bexplainAnalyzeBuffers\s*\(/, `${file} must assert query plans with explainAnalyzeBuffers()`);
  }
});

test('integration:db-speed-tests-assert-plans — the three database speed tests assert query plans and rows/buffers instead of wall-clock milliseconds, and pass three times in a row under a two-core CPU burner', { timeout: 1_800_000, skip: deferred }, async () => {
  // AC-1: none of the three files uses performance.now() for wall-clock limits; each uses explainAnalyzeBuffers (EXPLAIN (ANALYZE, BUFFERS)).
  const helper = await readFile(new URL('./helpers/query-plan.ts', import.meta.url), 'utf8');
  assert.match(helper, /EXPLAIN\s*\(\s*ANALYZE\s*,\s*BUFFERS/i, 'query-plan helper must run EXPLAIN (ANALYZE, BUFFERS)');
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bperformance\.now\s*\(/, `${file} still contains performance.now()`);
    assert.match(source, /\bexplainAnalyzeBuffers\s*\(/, `${file} must assert query plans with explainAnalyzeBuffers()`);
  }

  // AC-2: run the three files three times in a row while a CPU burner holds two cores busy; none fails.
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const burners = Array.from({ length: 2 }, () =>
    spawn(process.execPath, ['-e', 'let x = 1; while (true) { x = Math.sqrt(x * x + 1); }'], { stdio: 'ignore' }));
  try {
    for (let round = 1; round <= 3; round++) {
      const owned = process.env.GRAPHYARD_TEST_DATABASE_URL ? null : await startPostgres();
      const env: NodeJS.ProcessEnv = { ...baseEnv, GRAPHYARD_TEST_DATABASE_URL: process.env.GRAPHYARD_TEST_DATABASE_URL ?? owned!.url };
      try {
        for (const file of files) {
          const started = Date.now();
          const result = await runTestFile(file, env);
          if (result.code !== 0) console.error(`[db-speed-tests-assert-plans] round ${round} ${file} FAILED (${Math.round((Date.now() - started) / 1000)}s):\n${result.output.slice(-2000)}`);
          assert.equal(result.code, 0, `${file} failed on round ${round} under 2-core CPU load:\n${result.output.slice(-2000)}`);
          assert.match(result.output, /pass [1-9]\d*/, `${file} executed no tests on round ${round}:\n${result.output.slice(-1000)}`);
        }
      } finally {
        await owned?.stop();
      }
    }
  } finally {
    for (const burner of burners) burner.kill('SIGKILL');
  }
});
