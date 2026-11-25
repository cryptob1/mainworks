import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { masterStatusReport } from '../src/cli/master-status.js';
import { heavyTrial } from '../src/daemon/cycle-merge-writer.js';
import type { MasterConfig } from '../src/master.js';
import { acquireVerificationSlot, slotHolders, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3854: a test run from a session left `test merge GY-1` and `test merge GY-2` holders in the host's real slots.

const root = join(import.meta.dirname, '..');

/** Run a test file as a session does — bare, carrying the host's slot directory — and answer every holder label the directory ever showed. */
async function sessionTestRun(file: string) {
  const home = await temporaryDirectory('heavy-slot-home'), slots = join(home, '.local/share/graphyard/heavy-jobs');
  mkdirSync(slots, { recursive: true });
  writeFileSync(join(slots, 'limit'), '1\n');
  const { NODE_TEST_CONTEXT: _context, GRAPHYARD_DATA_HOME: _data, MAINWORKS_DATA_HOME: _renamed, ...environment } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...environment, HOME: home, [slotsDirectoryVariable]: slots, GRAPHYARD_HEAVY_JOB_PROJECT: 'owner/host' } });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const seen = new Set<string>();
  const watch = setInterval(() => { for (const holder of slotHolders(slots)) seen.add(holder.label); }, 2);
  try { const [code] = await once(child, 'close'); assert.equal(code, 0, output); } finally { clearInterval(watch); }
  return { slots, seen: [...seen] };
}

/** A holder that took the only slot and was killed before it could give it back. */
async function deadHolder(directory: string) {
  const ready = join(directory, 'ready');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { acquireVerificationSlot } from ${JSON.stringify(join(root, 'src/master/verification-slots.ts'))};
    import { writeFileSync } from 'node:fs';
    await acquireVerificationSlot({ directory: ${JSON.stringify(directory)}, label: 'test merge GY-1' });
    writeFileSync(${JSON.stringify(ready)}, '');
    setInterval(() => {}, 1000);
  `], { cwd: root, stdio: 'ignore' });
  const closed = once(child, 'close');
  while (!existsSync(ready)) { assert.equal(child.exitCode, null, 'the holder took its slot'); await new Promise(done => setTimeout(done, 20)); }
  child.kill('SIGKILL');
  await closed;
}

async function statusHolders(directory: string) {
  const checkout = await temporaryDirectory('heavy-slot-status');
  const master = { url: 'http://127.0.0.1:5', repository: 'owner/fixture', credentialFile: join(checkout, 'coordinator.token'), hostId: 'yard-box', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = directory;
  try { return (await masterStatusReport(checkout, master, async () => ({ work: [], now: new Date().toISOString() }), async () => '')).heavyJobs.holders.map(holder => holder.label); }
  finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
}

test('integration:heavy-slot-test-isolation — a test file that starts merge trials, run with a session\'s environment, never registers in the host\'s slots', { timeout: 120_000 }, async () => {
  const { slots, seen } = await sessionTestRun('tests/push-passed-trials-at-once.test.ts');
  assert.deepEqual(seen, []);
  assert.deepEqual(readdirSync(slots), ['limit'], 'the host\'s slot directory is unchanged');
});

test('integration:heavy-slot-test-isolation — every test file that starts trials is isolated from the host\'s slots', () => {
  const tests = join(root, 'tests');
  const open = readdirSync(tests).filter(name => name.endsWith('.test.ts')).filter(name => {
    const source = readFileSync(join(tests, name), 'utf8');
    return /mergeWriterStep|batchGateStep|mergeWriterReads|heavyTrial|mergeWriter:|withHeavyJob|acquireVerificationSlot/.test(source) && !/helpers\/(temp-dirs|pipeline-world)\.js/.test(source);
  });
  assert.deepEqual(open, [], 'import ./helpers/temp-dirs.js');
});

test('integration:heavy-slot-test-isolation — a holder whose process exited is not in master status and does not count toward the limit; a live one stays', { timeout: 60_000 }, async () => {
  const directory = await temporaryDirectory('heavy-slot-dead');
  writeFileSync(join(directory, 'limit'), '1\n');
  await deadHolder(directory);
  assert.deepEqual(await statusHolders(directory), []);
  const held = await acquireVerificationSlot({ directory, label: 'test merge GY-9', onWait: line => assert.fail(line) });
  try { assert.deepEqual(await statusHolders(directory), ['test merge GY-9']); } finally { held.release(); }
});

test('e2e:heavy-slot-test-isolation — after a test run that creates merge trials, the next merge trial starts without waiting for a slot', { timeout: 120_000 }, async () => {
  const { slots } = await sessionTestRun('tests/concurrent-affected-trials.test.ts');
  assert.deepEqual(await statusHolders(slots), []);
  const previous = process.env[slotsDirectoryVariable];
  process.env[slotsDirectoryVariable] = slots;
  try { assert.equal(await heavyTrial('GY-9', step => assert.fail(step), undefined, async () => 'started'), 'started'); }
  finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
});
