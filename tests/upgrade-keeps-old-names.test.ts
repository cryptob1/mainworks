import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { apiOk } from './helpers/api.js';
import { AgentRegistry } from '../src/agent-registry.js';
import { Engine } from '../src/engine.js';
import { runCycle } from '../src/daemon/cycle.js';
import { daemonEffects } from '../src/daemon/effects-production.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { loadMasterConfig, saveWorkerProfile, setupMaster } from '../src/master/config.js';
import { dispatchWork, prepareWorkerLaunch, workerCommand } from '../src/master/dispatch.js';
import { installDirectory, readInstallRecord } from '../src/install/secrets.js';
import { legacyInstallUnits, readInstallUnits } from '../src/install/units.js';
import { ensureTrialImage } from '../src/install/trial-image.js';
import { trialContainerImage } from '../src/merge-writer/trial-container.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { spawnHeadless } from '../src/headless-session.js';
import { liveRuns } from '../src/runner/registry.js';
import type { Principal, Work } from '../src/model.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { listen } from './helpers/http-server.js';
import { workFixture } from './helpers/work-fixture.js';

// GY-3594: an install created before the rename keeps running after it deploys, with no manual
// step. The old layout is seeded in a temporary home — the config directory ~/.config/graphyard,
// the loop unit graphyard-master.service and the trial image graphyard-trial:local — and the
// renamed code still finds each, answers status through the old launcher and dispatches one item
// into the old worktree path. Harness as tests/upgrade-keeps-old-names.test.ts: the real
// control plane, registry, loop cycle and headless dispatch, with a stand-in model executable.
const coordinator: Principal = { id: 'graphyard-master', role: 'coordinator' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const token = (principal: Principal) => `${principal.id}-token-${'x'.repeat(32)}`;
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
let store: Store, close: (() => Promise<void>) | undefined, registry: AgentRegistry;
let root: string, url: string, runtimeHome: string;
// The loop's clock runs `skew` ahead of the control plane's, so a back-off expires without the test waiting it out.
let skew = 0;
let bin: string;

before(async () => {
  store = await withDatabase('upgrade-keeps-old-names'); await store.init();
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('upgrade-keeps-old-names', join(process.cwd(), '.graphyard'));
  root = await temporaryDirectory('coordinator', scratch);
  bin = await temporaryDirectory('bin', scratch); const home = await temporaryDirectory('home', scratch);
  const engine = new Engine(store, 3600, 'owner/project'); engine.gitRunner = gitRunnerFor(root);
  ({ url, close } = await listen(server(engine, [coordinator, worker].map(principal => ({ ...principal, token: token(principal) })))));
  const { git } = await gitRepo({ root, files: { 'README.md': 'Fixture.\n' } });
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const credentials = await temporaryDirectory('credentials', scratch);
  await setupMaster(root, { url, token: token(coordinator), cliPath: launcher, credentialDirectory: credentials, run: { worktreeRoot: await temporaryDirectory('checkouts', scratch) } });
  const credentialFile = join(credentials, 'worker-a.token');
  await writeFile(credentialFile, token(worker), { mode: 0o600 });
  await saveWorkerProfile(root, { name: 'launch', principal: worker.id, agentName: 'eng-a', mode: 'launch', kind: 'claude', credentialFile }, async () => ({ actor: worker }));
  await writeFile(join(home, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'fixture-key' } }));
  // The model executable waits for the fixture to release its item, then commits and submits its head as the leased worker.
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const [, key, epoch] = /complete (GY-\\d+) (\\d+) --head/.exec(process.argv.slice(2).join(' ')) ?? [];
(async () => {
  while (!fs.existsSync(process.env.RUNTIME_HOME + '/release-' + key)) await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync('change.txt', 'done\\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.name=w', '-c', 'user.email=w@example.invalid', 'commit', '-qm', 'work']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await fetch(process.env.GRAPHYARD_URL + '/api/work/' + key + '/submit', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GRAPHYARD_TOKEN, 'Content-Type': 'application/json', 'Idempotency-Key': key + ':' + epoch }, body: JSON.stringify({ epoch: Number(epoch), head }) });
})();
`, { mode: 0o755 });
  runtimeHome = home;
  registry = new AgentRegistry(store);
  const hostId = (await loadMasterConfig(root)).hostId;
  await registry.mutate(coordinator, 'apply', { runtimes: [{ name: 'claude', launch: { kind: 'claude', args: [], headlessArgs: ['one-task', '--prompt', '{request}'], environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, homeVariable: 'RUNTIME_HOME', modelFlag: '--model' } }],
    accounts: [{ enabled: true, maxSessions: null, name: 'claude', runtime: 'claude', model: 'fixture', credential: { host: hostId, home } }], models: [{ name: 'fixture', id: 'fixture-model' }], roles: [{ name: 'worker', accounts: ['claude'], concurrency: 2 }], reason: 'one account at concurrency 2' }, randomUUID());
  await registry.observe(coordinator, { host: hostId, observations: [{ account: 'claude', quota: { loggedIn: true, state: 'available' }, smoke: { result: 'pass', reason: null } }] }, randomUUID());
});
after(async () => { await close?.(); if (store) await store.close(); });

const call = (method: 'GET' | 'POST', path: string, body?: unknown) => apiOk(url, token(coordinator), path, { method, body });
const snapshot = async () => { const read = await call('GET', 'work-snapshot') as { work: Work[]; now: string }; return { ...read, now: new Date(Date.parse(read.now) + skew).toISOString() }; };
async function readyItem(key: string, priority: number) {
  const work = workFixture({ id: randomUUID(), key, title: `Item ${key}`, description: 'Write change.txt.', type: 'bug', priority,
    criteria: [{ id: 'AC-1', text: 'change.txt exists', proofs: ['unit:works'] }] });
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work.id;
}
async function cycle(state: ReturnType<typeof emptyDaemonState>) {
  const config = await loadMasterConfig(root);
  const mutate = (path: string, data: unknown) => call('POST', path, data);
  const production = daemonEffects(root, () => config, { snapshot, mutate, headless: spawnHeadless });
  const effects: DaemonEffects = {
    snapshot, agents: () => [], herdr: production.herdr, credentials: production.credentials, closeSession: () => {}, recordSession: production.recordSession,
    cpuPressure: async () => ({ pressure: null, stat: null, celsius: null }), registry: production.registry, growWorkers: production.growWorkers, persist: async () => {},
    dispatch: (work, profile, _agents, read, launch) => dispatchWork(root, work, profile, { allWork: read.work, observedAt: read.now, headless: spawnHeadless, startupMs: 500,
      prepare: (at, key, name, _run, claimBy, keep, fetched) => prepareWorkerLaunch(at, key, name, (command, args, options) => command === 'git' && args[0] === 'fetch' ? '' : workerCommand(command, args, options), claimBy, keep, fetched),
      capacity: event => mutate(`work/${work.id}/capacity`, event), ...launch }),
  };
  await runCycle(config, state, effects, () => Date.now() + skew);
  return state;
}

const item = async (key: string) => (await snapshot()).work.find(entry => entry.key === key)!;
const running = () => liveRuns().filter(entry => entry.role === 'worker').map(entry => entry.work).sort();

test('integration:upgrade-keeps-old-names — an install from before the rename keeps its config directory, loop unit, trial image and worktree paths: status and one dispatch succeed after the upgrade', async () => {
  const home = await temporaryDirectory('upgrade-keeps-old-names-home');
  const saved = { HOME: process.env.HOME, GRAPHYARD_CONFIG_HOME: process.env.GRAPHYARD_CONFIG_HOME, GRAPHYARD_TRIAL_IMAGE: process.env.GRAPHYARD_TRIAL_IMAGE };
  process.env.HOME = home; delete process.env.GRAPHYARD_CONFIG_HOME; delete process.env.GRAPHYARD_TRIAL_IMAGE;
  try {
    // The old layout: the install record under ~/.config/graphyard, the legacy loop unit running this checkout, and the trial image under its old tag.
    const oldConfig = join(home, '.config', 'graphyard', 'owner-project');
    await mkdir(oldConfig, { recursive: true });
    await writeFile(join(oldConfig, 'install.json'), JSON.stringify({ version: 1, installId: 'owner-project', repository: 'owner/project', provider: 'compose', baseBranch: 'main', url,
      deployment: { local: true, port: 4310, image: 'graphyard-local:owner-project' }, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }), { mode: 0o600 });
    const units = join(home, '.config', 'systemd', 'user');
    await mkdir(units, { recursive: true });
    await writeFile(join(units, 'graphyard-master.service'), `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/bin/node ${root}/bin/graphyard.mjs master run\n`);
    const images = join(home, 'docker-images'), dockerLog = join(home, 'docker.log');
    await writeFile(images, 'graphyard-trial:local\n');
    await writeFile(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> ${dockerLog}
case "$1 $2" in
  "image inspect") grep -qxF "$3" ${images} ;;
  "tag "*) grep -qxF "$2" ${images} && echo "$3" >> ${images} ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

    // The config directory, unit and image are found where the old install left them.
    assert.equal(installDirectory('owner-project'), oldConfig);
    const record = await readInstallRecord(installDirectory('owner-project'));
    assert.deepEqual([record?.repository, record?.deployment?.image], ['owner/project', 'graphyard-local:owner-project']);
    assert.deepEqual(readInstallUnits(root, units, home), legacyInstallUnits);
    assert.equal(legacyInstallUnits.master, 'graphyard-master.service');
    await ensureTrialImage(root);
    const docker = await readFile(dockerLog, 'utf8');
    assert.match(docker, new RegExp(`^tag graphyard-trial:local ${trialContainerImage}$`, 'm'), 'the old trial image is taken under the new name');
    assert.doesNotMatch(docker, /build|pull/, 'nothing is rebuilt or pulled');

    // One dispatch: the loop claims the ready item and its worker runs in the old worktree path.
    await readyItem('GY-9911', 0);
    const state = await cycle(emptyDaemonState(await loadMasterConfig(root)));
    assert.deepEqual(running(), ['GY-9911'], JSON.stringify([state.actions, state.launchBackoff]));
    const leased = await item('GY-9911');
    assert.deepEqual([leased.epoch, !!leased.lease], [1, true]);
    const worktree = leased.workspaces.at(-1)!;
    assert.match(worktree.path, /\/\.graphyard\/worktrees\/GY-9911-1$/);
    assert.equal(worktree.branch, 'graphyard/gy-9911-1');
    assert.ok(existsSync(worktree.path));

    // Status answers through the old launcher, bin/graphyard.mjs.
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GRAPHYARD|MAINWORKS)_/.test(name)));
    const status = JSON.parse((await promisify(execFile)(process.execPath, [launcher, 'status', 'GY-9911'], { cwd: root, encoding: 'utf8', env: { ...cleanEnv, HOME: home, GRAPHYARD_TOKEN_FILE: '', GRAPHYARD_URL: url, GRAPHYARD_TOKEN: token(coordinator) } })).stdout);
    assert.deepEqual([status.key, status.epoch], ['GY-9911', 1]);

    await writeFile(join(runtimeHome, 'release-GY-9911'), '');
    for (let tries = 0; tries < 600 && running().length; tries++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(running(), []);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
