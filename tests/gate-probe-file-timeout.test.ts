import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, runGate, type GatePorts } from '../src/batch-gate.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3620: on 2026-11-21 from 19:55Z nothing deployed: two batch gates timed out and a third spent
// 16+ minutes probing tests/affected-after-back-merge.test.ts on the verified commit, while a merge
// trial caps a file at five minutes. The gate's rerun and its verified-commit probe now stop a file
// at that same per-file bound; the file counts as failed for that step and the run settles as usual.

/** The merge trial's per-file bound (src/merge-writer/trial.ts --file-timeout). */
const trialFileTimeoutMs = 5 * 60_000;
const verified = 'a'.repeat(40), tip = 'b'.repeat(40), check = 'test:tests/hang.test.ts';
/** The gate's clock runs 200 times faster than the wall: a second is 3m20s, the 45-minute bound 13.5 s. */
const speed = 200;

/** Runs a real test file that never finishes until the step's signal stops it: failed when it exits non-zero. */
const runFile = (file: string, signal?: AbortSignal) => new Promise<string[]>(resolve => {
  const child = spawn(process.execPath, ['--test', file], { stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')) });
  const stop = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', stop, { once: true });
  child.on('close', code => { signal?.removeEventListener('abort', stop); resolve(code === 0 ? [] : [check]); });
});

/** One gate whose tip fails `check`; `hangs` names the step whose run of it never finishes. */
async function gate(hangs: 'rerun' | 'probe') {
  const directory = await temporaryDirectory('gate-probe-file-timeout-');
  const file = join(directory, 'hang.test.mjs');
  await writeFile(file, "import { test } from 'node:test';\ntest('never ends', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  const started = Date.now(), steps: string[] = [];
  let tipRuns = 0;
  const ports: GatePorts = {
    now: () => started + (Date.now() - started) * speed,
    fetch: async () => tip, landings: async () => [], files: async () => ['tests/hang.test.ts'], catalog: async () => [], core: async () => [],
    run: async (commit, _checks, _files, _timeoutMs, signal, onStep) => {
      const step = commit === tip ? (++tipRuns === 1 ? 'main' : 'rerun') : 'probe';
      steps.push(step);
      onStep?.('tests');
      return step === hangs ? runFile(file, signal) : [check];
    },
    revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }),
  };
  const outcome = await runGate(ports, bootstrapGate('owner/project', verified));
  return { outcome, steps, wallMs: Date.now() - started };
}

for (const hangs of ['rerun', 'probe'] as const) {
  test(`integration:gate-probe-file-timeout — a hanging test file in the gate's ${hangs} stops at the trial's per-file timeout, counts as failed, and the gate settles without timing out`, { timeout: 60_000 }, async () => {
    const { outcome, steps, wallMs } = await gate(hangs);
    assert.notEqual(outcome.outcome, 'timeout', `the ${hangs} ended the whole gate as a timeout instead of stopping the file at ${trialFileTimeoutMs} ms`);
    assert.deepEqual(steps, ['main', 'rerun', 'probe'], 'the hanging step settles and the gate goes on to the next one');
    assert.equal(outcome.outcome, 'verified', 'the check fails on the verified commit too, so it is a filed known red and the batch is kept');
    assert.deepEqual(outcome.outcome === 'verified' && outcome.knownRed, [check]);
    assert.ok(wallMs * speed < 2 * trialFileTimeoutMs + 60_000, `the file stopped near its five-minute bound, not after ${Math.round(wallMs * speed / 60_000)} gate minutes`);
  });
}

test('e2e:gate-probe-file-timeout — a gate whose verified-commit probe hits a hanging file reaches an outcome other than timeout', { timeout: 60_000 }, async () => {
  const { outcome } = await gate('probe');
  assert.notEqual(outcome.outcome, 'timeout');
});

test('integration:gate-probe-file-timeout — an e2e case in the rerun keeps its own step timeouts: one that runs past five minutes and passes is not stopped as a test file', { timeout: 60_000 }, async () => {
  const started = Date.now(), e2e = 'e2e:slow-case';
  let tipRuns = 0;
  const ports: GatePorts = {
    now: () => started + (Date.now() - started) * speed,
    fetch: async () => tip, landings: async () => [], files: async () => [], catalog: async () => ['slow-case'], core: async () => [],
    run: async (commit, _checks, _files, _timeoutMs, signal, onStep) => {
      if (commit !== tip || ++tipRuns === 1) return [e2e];
      onStep?.('tests: e2e');
      // The rerun's case passes after 15 gate minutes: three per-file bounds, well inside its own 30-minute step limit.
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 15 * 60_000 / speed); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      return signal?.aborted ? [e2e] : [];
    },
    revert: async () => { throw new Error('unused'); }, file: async () => ({ item: null }),
  };
  const outcome = await runGate(ports, bootstrapGate('owner/project', verified));
  assert.equal(outcome.outcome, 'verified', `the e2e rerun was cut short: ${JSON.stringify(outcome)}`);
  assert.deepEqual(outcome.outcome === 'verified' && outcome.flakes, [e2e]);
});
