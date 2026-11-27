import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master.js';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { fleetCommand } from '../src/cli/master/fleet.js';
import { heavyJobBudget, slotsDirectoryVariable, writeMachines } from '../src/master/verification-slots.js';

// GY-3701: a leftover `limit` file fixed the heavy-job budget at 3 on a line whose ready hosts
// could run 13; the Lead lifts it with `master config hostHeavyJobs=auto`.

test('unit:lead-lifts-fixed-heavy-limit — hostHeavyJobs=auto removes the limit file as the operator-agent and the budget scales with the ready hosts', async () => {
  const scratch = await temporaryDirectory('lift-heavy-limit'), directory = join(scratch, 'heavy-jobs'), previous = process.env[slotsDirectoryVariable];
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'limit'), '3\n');
  writeMachines(directory, [{ name: 'this machine', local: true, away: false, cores: 24, busy: 2, celsius: null },
    { name: 'host-a', away: false, cores: 24, busy: 0, celsius: null }, { name: 'host-b', away: false, cores: 32, busy: 0, celsius: null }]);
  assert.equal(heavyJobBudget(directory).slots, 3);
  const root = join(scratch, 'repo'), credentialFile = join(scratch, 'operator.token');
  await gitRepo({ root }); writeFileSync(credentialFile, 'operator-agent-token-'.padEnd(40, 'x')); chmodSync(credentialFile, 0o600);
  const printed: unknown[] = [];
  const config = (master: Record<string, unknown>) => fleetCommand({ id: 'config', args: ['hostHeavyJobs=auto'], root, master,
    print: (value: unknown) => { printed.push(value); return value; }, coordinator: { actor: { id: 'graphyard-master-app' } } } as never);
  process.env[slotsDirectoryVariable] = directory;
  try {
    await assert.rejects(config({ masterAgentName: 'graphyard-master-app' }), /operator-agent identity/);
    assert.ok(existsSync(join(directory, 'limit')), 'without the operator-agent identity the file stays');
    await config({ masterAgentName: 'graphyard-master-app', operatorAgent: { id: 'lead-agent', credentialFile } });
  } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
  assert.equal(existsSync(join(directory, 'limit')), false);
  assert.equal(heavyJobBudget(directory).slots, 13);
  const shown = printed.at(-1) as { hostHeavyJobs: { lifted: number; by: string; budget: string } };
  assert.match(shown.hostHeavyJobs.budget, /^13 heavy-job slots \(this machine 4, host-a 4, host-b 5\)$/);
  assert.equal(shown.hostHeavyJobs.lifted, 3);
  assert.equal(shown.hostHeavyJobs.by, 'lead-agent');
  assert.equal(JSON.parse(readFileSync(join(directory, 'limit-lifted.json'), 'utf8')).by, 'lead-agent');
});

test('e2e:verification-uses-remote-hosts — master status names a fixed limit file while a host is ready, with the budget it hides and the command that lifts it', async () => {
  const { root } = await gitRepo({ label: 'fixed-limit-status' }), directory = join(await temporaryDirectory('fixed-limit-data'), 'heavy-jobs'), previous = process.env[slotsDirectoryVariable];
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'limit'), '3\n');
  const machines = (hostAway: boolean) => writeMachines(directory, [{ name: 'this machine', local: true, away: false, cores: 24, busy: 2, celsius: null },
    { name: 'host-a', away: hostAway, cores: 24, busy: 0, celsius: null }, { name: 'host-b', away: hostAway, cores: 32, busy: 0, celsius: null }]);
  const credentials = await temporaryDirectory('fixed-limit-credentials');
  const master = { url: 'http://127.0.0.1:5', repository: 'owner/fixture', credentialFile: join(credentials, 'coordinator.token'), hostId: 'yard-box', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const attention = async () => (await masterStatusReport(root, master, async () => ({ work: [], now: new Date().toISOString() }), async () => '')).attention
    .filter(line => line.subject === 'heavy-job budget');
  process.env[slotsDirectoryVariable] = directory;
  try {
    machines(false);
    assert.deepEqual(await attention(), [{ subject: 'heavy-job budget', text: `The heavy-job budget is fixed at 3 by ${join(directory, 'limit')}; without it the ready machines give 13.`, next: 'mainworks master config hostHeavyJobs=auto' }]);
    machines(true);
    assert.deepEqual(await attention(), [], 'with no compute host ready the file hides nothing');
    machines(false);
    rmSync(join(directory, 'limit'));
    assert.deepEqual(await attention(), [], 'with the file gone the line is gone');
  } finally { if (previous === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = previous; }
});
