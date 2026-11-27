import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { runCycle } from '../src/daemon/cycle.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { dispatchWork, prepareWorkerLaunch, workerCommand } from '../src/master/dispatch.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { spawnHeadless } from '../src/headless-session.js';
import { liveRuns } from '../src/runner/registry.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { listen } from './helpers/http-server.js';
import { workFixture } from './helpers/work-fixture.js';
import { apiOk } from './helpers/api.js';

// GY-3730: the registry's worker role decides who builds. master.json holds no worker profile at
// all; a stub-runtime account placed first in the worker role takes the first ready item through
// the real control plane, registry, loop cycle, claim and headless dispatch. The only substitute is
// the runtime's model executable, which records its start and submits its head.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const accounts = ['stub-a', 'other-b'];
let store: Store, close: (() => Promise<void>) | undefined, registry: AgentRegistry;
let root: string, scratch: string, bin: string, url: string;
const homes = new Map<string, string>();

before(async () => {
  store = await withDatabase('role-account-builds'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  scratch = await temporaryDirectory('role-account-builds', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch);
  const engine = new Engine(store, 120, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  ({ url, close } = await listen(server(engine, [{ ...coordinator, token: token(coordinator) }])));
  const { git } = await gitRepo({ root, files: { 'README.md': 'Fixture.\n' } });
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  registry = new AgentRegistry(store);
  const hostId = (await loadMasterConfig(root)).hostId, runtimes = [], fleet = [];
  for (const name of accounts) {
    const home = await temporaryDirectory(name, scratch); homes.set(name, home);
    // The model executable: it records which account started, commits and submits its head as the leased worker.
    await writeFile(join(bin, name), `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [, key, epoch] = /complete (GY-\\d+) (\\d+) --head/.exec(process.argv.slice(2).join(' ')) ?? [];
fs.appendFileSync(process.env.RUNTIME_HOME + '/starts', key + '\\n');
fs.writeFileSync('change.txt', 'done\\n');
execFileSync('git', ['add', '-A']);
execFileSync('git', ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-qm', 'work']);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await fetch(process.env.GRAPHYARD_URL + '/api/work/' + key + '/submit', { method: 'POST', headers: { Authorization: 'Bearer ' + fs.readFileSync(process.env.GRAPHYARD_TOKEN_FILE, 'utf8').trim(), 'Content-Type': 'application/json', 'Idempotency-Key': key + ':' + epoch }, body: JSON.stringify({ epoch: Number(epoch), head }) });
`, { mode: 0o755 });
    runtimes.push({ name, launch: { kind: name, args: [], headlessArgs: ['one-task', '--prompt', '{request}'], environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model' } });
    fleet.push({ enabled: true, maxSessions: null, name, runtime: name, model: 'fixture', credential: { host: hostId, home } });
  }
  await registry.mutate(coordinator, 'apply', { runtimes, accounts: fleet, models: [{ name: 'fixture', id: 'fixture-model' }], roles: [{ name: 'worker', accounts, concurrency: 1 }], reason: 'a stub account first in the worker role' }, randomUUID());
  await registry.observe(coordinator, { host: hostId, observations: accounts.map(account => ({ account, quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } })) }, randomUUID());
});
after(async () => { await close?.(); if (store) await store.close(); });

const api = (method: 'GET' | 'POST', path: string, body?: unknown) => apiOk(url, token(coordinator), path, { method, body });
const snapshot = () => api('GET', 'work-snapshot') as Promise<{ work: Work[]; now: string }>;

async function cycle(state: ReturnType<typeof emptyDaemonState>) {
  const config = await loadMasterConfig(root);
  const mutate = (path: string, data: unknown) => api('POST', path, data);
  const production = daemonEffects(root, () => config, { snapshot, mutate, headless: spawnHeadless });
  const effects: DaemonEffects = {
    snapshot, agents: () => [], herdr: production.herdr, credentials: production.credentials, closeSession: () => {}, recordSession: production.recordSession,
    registry: production.registry, growWorkers: production.growWorkers, persist: async () => {},
    dispatch: (work, profile, _agents, read, launch) => dispatchWork(root, work, profile, { allWork: read.work, observedAt: read.now, headless: spawnHeadless, startupMs: 500,
      prepare: (at, key, name, _run, claimBy, keep, fetched) => prepareWorkerLaunch(at, key, name, (command, args, options) => command === 'git' && args[0] === 'fetch' ? '' : workerCommand(command, args, options), claimBy, keep, fetched),
      capacity: event => mutate(`work/${work.id}/capacity`, event), ...launch }),
  };
  await runCycle(config, state, effects);
}

test('e2e:role-account-builds — master.json names no worker profile; the stub account first in the worker role claims and builds the first released item', async () => {
  assert.deepEqual((await loadMasterConfig(root)).workers, [], 'master.json holds no worker profile');
  const work = workFixture({ id: randomUUID(), key: 'GY-9900', title: 'Item', description: 'Write change.txt.', type: 'bug', priority: 1, criteria: [{ id: 'AC-1', text: 'change.txt exists', proofs: ['unit:works'] }] });
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);

  const state = emptyDaemonState(await loadMasterConfig(root));
  const item = async () => (await snapshot()).work.find(entry => entry.key === 'GY-9900')!;
  for (let cycles = 0; cycles < 6 && !(await item()).lease && !(await item()).submission; cycles++) await cycle(state);
  const actions = JSON.stringify(Object.values(state.actions).map(action => action.detail));
  const claimed = await item();
  assert.ok(claimed.lease || claimed.submission, `the item was claimed: ${actions}`);

  // The worker session that claimed it runs on the stub account, the first of the role.
  const session = (await registry.document(coordinator)).sessions.find(entry => entry.role === 'worker' && entry.work === 'GY-9900');
  assert.equal(session?.account, 'stub-a', actions);
  for (let tries = 0; tries < 600 && !(await readFile(join(homes.get('stub-a')!, 'starts'), 'utf8').catch(() => '')).includes('GY-9900'); tries++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(await readFile(join(homes.get('stub-a')!, 'starts'), 'utf8'), /GY-9900/, 'the stub runtime started for the item');
  assert.equal(await readFile(join(homes.get('other-b')!, 'starts'), 'utf8').catch(() => ''), '', 'the account second in the role did not start');
  const config = await loadMasterConfig(root);
  assert.equal(config.workers.length, 2, 'the loop minted the worker identities itself, one per worker the role allows');
  assert.ok(config.workers.every(profile => profile.minted && profile.kind === undefined), 'every profile is the loop\'s own and names no runtime');
  assert.match(actions, /Dispatched GY-9900 to stub-a \(stub-a\)/, 'the dispatch line names the account that builds');

  for (let tries = 0; tries < 600 && liveRuns().some(entry => entry.role === 'worker'); tries++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await item()).submission?.epoch, 1, 'the stub account submitted its head');
});
