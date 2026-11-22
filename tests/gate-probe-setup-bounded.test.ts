import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapGate, runGate, type GatePorts } from '../src/batch-gate.js';
import { heavyTrial } from '../src/daemon/cycle-merge-writer.js';
import { declarationSlot, heldSlots, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { trialFileTimeoutMs } from '../src/merge-writer/trial-load.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3659: a gate's verified-commit probe that hangs in setup (checkout, install, build) never
// reaches its test runner, so GY-3620's per-file timeout never started and the probe sat holding
// a host heavy-job slot until the whole gate timed out. Probe setup now shares that same per-step
// bound: exceeding it stops the probe, releases its heavy-job slot, counts the probe as failed,
// and lets the gate settle under the existing rules.

const verified = 'a'.repeat(40), tip = 'b'.repeat(40), check = 'test:tests/hang-setup.test.ts';
/** The gate's clock runs 200 times faster than the wall: 1 s is 3m20s, the 45-minute bound 13.5 s. */
const speed = 200;

const previousSlots = process.env[slotsDirectoryVariable];
after(() => {
  if (previousSlots === undefined) delete process.env[slotsDirectoryVariable];
  else process.env[slotsDirectoryVariable] = previousSlots;
});

const holders = (directory: string) => heldSlots(directory).filter(entry => entry.slot < declarationSlot).map(entry => entry.owner?.label);

/** One gate whose tip fails `check` twice and whose verified-commit probe hangs in setup forever. */
async function gateWithHangingProbeSetup(probeCheck = check) {
  const base = await temporaryDirectory('gate-probe-setup-bounded-');
  const slots = join(base, 'heavy-jobs');
  await mkdir(slots, { recursive: true });
  await writeFile(join(slots, 'limit'), '1\n');
  process.env[slotsDirectoryVariable] = slots;

  const started = Date.now(), steps: string[] = [];
  let tipRuns = 0, probeAborted = false, slotsDuringProbe: (string | undefined)[] = [], slotsAfterProbe: (string | undefined)[] = [];
  let releaseHungSetup!: () => void;
  const hungSetup = new Promise<void>(resolve => { releaseHungSetup = resolve; });

  const record = bootstrapGate('owner/project', verified);
  const ports: GatePorts = {
    now: () => started + (Date.now() - started) * speed,
    fetch: async () => tip,
    landings: async () => [],
    files: async () => ['tests/hang-setup.test.ts'],
    catalog: async () => probeCheck.startsWith('e2e:') ? [probeCheck.slice(4)] : [],
    core: async () => [],
    run: async (commit, _checks, _files, _timeoutMs, signal, onStep) => {
      if (commit === tip) {
        steps.push(++tipRuns === 1 ? 'main' : 'rerun');
        onStep?.('tests');
        return [probeCheck];
      }
      steps.push('probe');
      signal?.addEventListener('abort', () => { probeAborted = true; }, { once: true });
      return heavyTrial('batch-gate', onStep, signal, async () => {
        slotsDuringProbe = holders(slots);
        onStep?.('checkout');
        // Never reaches the test runner; stays stuck in checkout even after signal aborts.
        await hungSetup;
        return [];
      });
    },
    revert: async () => { throw new Error('unused'); },
    file: async () => ({ item: null }),
  };

  try {
    const outcome = await runGate(ports, record);
    slotsAfterProbe = holders(slots);
    return { outcome, steps, probeAborted, slotsDuringProbe, slotsAfterProbe, wallMs: Date.now() - started };
  } finally {
    releaseHungSetup();
  }
}

test('integration:gate-probe-setup-bounded — a verified-commit probe whose setup never reaches its test runner is stopped at the per-step bound, releases its heavy-job slot, counts as failed, and the gate settles', { timeout: 60_000 }, async () => {
  const { outcome, steps, probeAborted, slotsDuringProbe, slotsAfterProbe, wallMs } = await gateWithHangingProbeSetup();
  assert.notEqual(outcome.outcome, 'timeout', `the hanging probe setup timed out the whole gate instead of stopping at ${trialFileTimeoutMs} ms`);
  assert.deepEqual(steps, ['main', 'rerun', 'probe'], 'the gate ran main, rerun, and the verified-commit probe');
  assert.equal(probeAborted, true, 'the hanging probe setup was stopped via its abort signal');
  assert.deepEqual(slotsDuringProbe, ['test merge batch-gate'], 'the probe held a host heavy-job slot during setup');
  assert.deepEqual(slotsAfterProbe, [], 'the stopped probe released its host heavy-job slot even while its hung setup had not settled');
  assert.equal(outcome.outcome, 'verified', 'the failed probe counts as known red on the verified commit and the gate settles verified');
  assert.deepEqual(outcome.outcome === 'verified' && outcome.knownRed, [check]);
  assert.ok(wallMs * speed < 2 * trialFileTimeoutMs + 60_000, `probe setup stopped near its five-minute bound, not after ${Math.round(wallMs * speed / 60_000)} gate minutes`);
});

test('integration:gate-probe-setup-bounded — a verified-commit probe for a catalog-only e2e case whose setup never reaches its test runner is also stopped and counted as failed', { timeout: 60_000 }, async () => {
  const e2e = 'e2e:catalog-case';
  const { outcome, steps, probeAborted, slotsAfterProbe, wallMs } = await gateWithHangingProbeSetup(e2e);
  assert.notEqual(outcome.outcome, 'timeout', `the hanging e2e probe setup timed out the whole gate: ${JSON.stringify(outcome)}`);
  assert.deepEqual(steps, ['main', 'rerun', 'probe']);
  assert.equal(probeAborted, true);
  assert.deepEqual(slotsAfterProbe, []);
  assert.equal(outcome.outcome, 'verified');
  assert.deepEqual(outcome.outcome === 'verified' && outcome.knownRed, [e2e]);
  assert.ok(wallMs * speed < 2 * trialFileTimeoutMs + 60_000);
});

test('e2e:gate-probe-setup-bounded — a gate whose probe setup hangs reaches an outcome other than timeout', { timeout: 60_000 }, async () => {
  const { outcome } = await gateWithHangingProbeSetup();
  assert.notEqual(outcome.outcome, 'timeout');
});
