import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterCauses } from '../src/daemon/master-stalled-delivery.js';
import { daemonSummary } from '../src/daemon/run.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master/profiles.js';
import type { Work } from '../src/model.js';
import type { AgentRegistry, CanaryOffer, FleetRuntime } from '../src/model/registry.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workFixture } from './helpers/work-fixture.js';

/**
 * GY-3883: a runtime canary whose session ends on its provider's limit notice judged the account,
 * not the version: it is inconclusive (notice and reset kept), the runtime is neither failed nor
 * switched, and the next launch of the runtime runs the canary again. Any other early end still fails it.
 */
const scratch = await temporaryDirectory('canary-limit');
after(() => rm(scratch, { recursive: true, force: true }));
const t0 = Date.parse('2030-01-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const installs = join(scratch, 'mise', 'installs', 'opencode');
for (const version of ['2.2.4', '2.2.5']) await mkdir(join(installs, version, 'bin'), { recursive: true });
const token = join(scratch, 'coordinator.token'), workerToken = join(scratch, 'worker.token');
await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
await writeFile(workerToken, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
const profiles = Array.from({ length: 3 }, (_, index): WorkerProfile => ({ name: `opencode-${index}`, principal: `worker-${index}`, agentName: `agent-${index}`, mode: 'launch', kind: 'claude', credentialFile: workerToken, agentArgs: [], environment: {} }) as unknown as WorkerProfile);
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
  repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: profiles });
const runtime: FleetRuntime = { name: 'opencode', launch: { kind: 'opencode', args: [], environment: { PATH: `${join(installs, '2.2.4', 'bin')}:/usr/bin:/bin` }, homeVariable: 'XDG_DATA_HOME', modelFlag: null, login: null, loginFile: null } } as unknown as FleetRuntime;
const registry = { runtimes: [runtime], accounts: [{ name: 'oc-a', runtime: 'opencode' }, { name: 'oc-b', runtime: 'opencode' }] as AgentRegistry['accounts'],
  roles: [{ name: 'worker', accounts: ['oc-a', 'oc-b'], concurrency: 5 }] as AgentRegistry['roles'] } as Pick<AgentRegistry, 'runtimes' | 'accounts' | 'roles'>;
const work = (id: string, key: string, overrides: Partial<Work> = {}) => workFixture({ id, key, priority: 1, createdAt: iso(t0 - 3_600_000), updatedAt: iso(t0), stageEnteredAt: iso(t0), ...overrides });
const ended = (outcome: string) => ({ id: 'worker-0:1', kind: 'implementation', principal: 'worker-0', runtime: 'opencode', host: 'machine-b', epoch: 1, subject: 'GY-1',
  state: 'finished', startedAt: iso(t0), runtimeStartedAt: iso(t0), updatedAt: iso(t0 + 5_000), endedAt: iso(t0 + 5_000), initialHead: 'a'.repeat(40), outcome });

function harness(items: Work[]) {
  let now = t0;
  const launches: { key: string; canaries: CanaryOffer[] }[] = [], switched: string[] = [];
  const state = emptyDaemonState(config);
  const effects: DaemonEffects = {
    agents: () => [], persist: async () => {}, closeSession: () => {},
    credentials: async list => Object.fromEntries(list.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: items, now: iso(now) }),
    registry: async () => registry,
    setRuntime: async (_next, reason) => { switched.push(reason); },
    dispatch: async (item, _profile, _agents, _snapshot, launch) => {
      launches.push({ key: item.key, canaries: launch?.canaries ?? [] });
      const canary = launch?.canaries?.find(offer => offer.runtime === 'opencode');
      launch?.onRuntime?.('opencode');
      return { epoch: 1, runtime: 'opencode', runtimeStartedAt: iso(now), canary: canary ? { runtime: canary.runtime, failed: null } : null };
    },
  };
  const cycle = async (at: number) => { now = at; await runCycle(config, state, effects, () => now, undefined, () => {}); };
  return { state, launches, switched, cycle };
}

test('integration:canary-limit-inconclusive — a canary stopped by its provider\'s limit notice is inconclusive with the notice and reset, neither failed nor promoted, and runs again on the next launch of its runtime', async () => {
  const items = [work('one', 'GY-1')];
  const run = harness(items);
  await run.cycle(t0);
  assert.equal(run.launches[0].canaries[0]?.version, '2.2.5', 'the first launch is the canary');
  items[0] = { ...items[0], epoch: 1, sessions: [ended("the headless run stopped on its provider's limit notice: You've hit your usage limit · resets 2030-01-01T05:00:00Z")] } as Work;
  await run.cycle(t0 + 10_000);
  const canary = run.state.canaries.opencode;
  assert.equal(canary.failed, null, 'a spent account is no version defect');
  assert.match(canary.inconclusive?.notice ?? '', /hit your usage limit/);
  assert.equal(canary.inconclusive?.resetsAt, '2030-01-01T05:00:00.000Z');
  assert.equal(run.switched.length, 0, 'the version is not promoted');
  assert.equal(masterCauses(items, run.state.actions).filter(cause => cause.key === 'runtime-canary:opencode').length, 0, 'nothing failed, so the master is not woken');
  // Master status shows it.
  const status = daemonSummary(run.state, t0 + 10_000, 30_000);
  assert.match(status.canaries.opencode.inconclusive?.notice ?? '', /usage limit/);
  assert.match(status.actions.find(action => action.key === 'runtime-canary:opencode')?.detail ?? '', /inconclusive.*retried/);
  // The next launch of the runtime, on another account or after the reset, runs the canary again.
  items.push(work('two', 'GY-2'));
  await run.cycle(t0 + 20_000);
  assert.equal(run.launches.at(-1)?.key, 'GY-2');
  assert.equal(run.launches.at(-1)?.canaries[0]?.version, '2.2.5', 'the inconclusive canary is retried');
  assert.equal(run.state.canaries.opencode.work, 'GY-2');
});

test('integration:canary-limit-inconclusive — a canary that ends early for any other reason is still judged failed', async () => {
  const items = [work('one', 'GY-1')];
  const run = harness(items);
  await run.cycle(t0);
  items[0] = { ...items[0], epoch: 1, sessions: [ended('opencode exited: unknown flag --prompt')] } as Work;
  await run.cycle(t0 + 10_000);
  assert.match(run.state.canaries.opencode.failed ?? '', /unknown flag --prompt/);
  assert.equal(run.state.canaries.opencode.inconclusive ?? null, null);
  assert.equal(masterCauses(items, run.state.actions).filter(cause => cause.key === 'runtime-canary:opencode').length, 1);
  items.push(work('two', 'GY-2'));
  await run.cycle(t0 + 20_000);
  assert.deepEqual(run.launches.at(-1)?.canaries, [], 'a failed version is not offered again');
});
