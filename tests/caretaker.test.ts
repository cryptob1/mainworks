import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Store } from '../src/store.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { Launcher, runCycle } from '../src/daemon/cycle.js';
import { caretakerIntervalMs, caretakerStep, type CaretakerOutcome } from '../src/daemon/caretaker.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { caretakerChecks, caretakerCommands, caretakerPrompt, caretakerReads, caretakerRequestsFile } from '../src/master/caretaker-prompt.js';
import { serveCaretakerRequests } from '../src/master/caretaker.js';
import { loopRestartRequestPath } from '../src/daemon/run.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { encodeLoopHosts, loopHostsHeader, loopPresenceHeader } from '../src/model/loop-presence.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { boardFromStatus } from '../src/model/board.js';
import OverviewPage from '../web/pages/overview.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import type { Principal, Work } from '../src/model.js';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

// GY-3593: a caretaker keeps each install healthy on a schedule, separate from the master that builds.

const config = (url = 'http://127.0.0.1:9', credentialFile = '/outside/coordinator.token'): MasterConfig => masterConfigSchema.parse({ version: 1, url, credentialFile, cliPath: '/bin/graphyard',
  repository: 'owner/caretaker', baseBranch: 'main', githubAppId: 1234, hostId: 'care-host', masterAgentName: 'graphyard-master-care', workers: [] });

test('unit:caretaker-runs-once-per-interval — one run starts per 30 minutes, none while one is live, and a run with no account is skipped with its reason', async () => {
  const at = Date.parse('2026-11-21T12:00:00Z');
  let clock = at, starts = 0, finish!: (outcome: CaretakerOutcome) => void, next: CaretakerOutcome | null = null;
  const state = emptyDaemonState(config()), launcher = new Launcher();
  const effects = { persist: async () => {}, caretaker: () => { starts++; return next ? Promise.resolve(next) : new Promise<CaretakerOutcome>(resolve => { finish = resolve; }); } } as unknown as DaemonEffects;
  const step = async () => { caretakerStep({ config: config(), state, effects, clock, launcher, now: () => clock }); await new Promise(resolve => setImmediate(resolve)); };

  await step();
  assert.equal(starts, 1, 'the first cycle starts a run');
  assert.equal(state.caretaker?.result, 'Running');
  clock = at + caretakerIntervalMs + 60_000;
  await step();
  assert.equal(starts, 1, 'none starts while one is live, even past its interval');
  finish({ result: 'Reported 6 lines: checked: every account answers' });
  await launcher.idle();
  assert.deepEqual(state.caretaker, { at: new Date(at).toISOString(), result: 'Reported 6 lines: checked: every account answers' });

  clock = at + caretakerIntervalMs - 1;
  await step();
  assert.equal(starts, 1, 'none starts before 30 minutes have passed since the last start');
  clock = at + caretakerIntervalMs;
  next = { skipped: 'No healthy agent account for caretaker profile caretaker: role caretaker has no available account' };
  await step();
  await launcher.idle();
  assert.equal(starts, 2, 'one starts once the interval has passed');
  assert.equal(state.caretaker?.result, 'Skipped: No healthy agent account for caretaker profile caretaker: role caretaker has no available account', 'a skip states why');
  clock += 60_000;
  await step();
  assert.equal(starts, 2, 'a skipped run waits out its interval too');
  // A personal master's scope never starts the install's caretaker.
  clock += caretakerIntervalMs;
  caretakerStep({ config: { ...config(), forPerson: 'ana' }, state, effects, clock, launcher, now: () => clock });
  assert.equal(starts, 2);
});

test('unit:caretaker-checklist-is-complete — the one prompt file holds all six checks and names only permitted commands', () => {
  const prompt = caretakerPrompt('graphyard');
  const checks = [/held or broken account gets a live request/, /provider's own sentence as the reason/, /compute host is ready, or the reason it is away is recorded/,
    /verified a commit within the last 6 hours, or its last outcome is named/, /no item is ready or in a stage with no actor for over 30 minutes/,
    /served build is within 10 merged items of main/, /merges per hour over the last 6 and 24 hours/];
  for (const check of checks) assert.match(prompt, check);
  assert.equal(caretakerChecks.length, 6);
  for (let index = 1; index <= 6; index++) assert.match(prompt, new RegExp(`^\\(${index}\\) `, 'm'), `check ${index} is numbered`);
  assert.match(prompt, /no open item already names the fault/, 'it looks for an open item before filing one');
  const named = [...prompt.matchAll(/graphyard ((?:[a-z]+ ?)+)/g)].map(match => match[1]!.trim());
  assert.ok(named.length >= 8);
  const allowed = [...caretakerCommands, ...caretakerReads];
  for (const command of named) assert.ok(allowed.some(entry => command === entry || command.startsWith(`${entry} `)), `${command} is a permitted command`);
  // A master command needs the coordinator identity: the caretaker's token runs none of them.
  assert.ok(!named.some(entry => entry.startsWith('master')), 'the prompt names no master command');
  for (const command of ['caretaker registry account quota', 'unblock', 'caretaker dispatch', 'caretaker restart', 'create', 'caretaker report'])
    assert.ok(named.some(entry => entry.startsWith(command)), `the prompt names ${command}`);
  for (const forbidden of ['release', 'close', 'rework', 'requirements', 'answer', 'role set', 'priority', 'attest'])
    assert.ok(!named.some(entry => entry.split(' ').includes(forbidden.split(' ')[0]!) && !entry.startsWith('caretaker')), `the prompt never names ${forbidden}`);
});

let store: Store | undefined, http: ReturnType<typeof server> | undefined;
after(async () => { http?.close(); await store?.close(); });

test('e2e:caretaker-report-on-home — a caretaker pass makes a held account that answers available, reports, Home shows the away host and its token cannot revise requirements', async () => {
  const operator: Principal = { id: 'care-operator', role: 'admin', sessionKind: 'human' };
  const coordinator: Principal = { id: 'care-loop', role: 'coordinator', sessionKind: 'ai' };
  const credentials = [operator, coordinator].map(principal => ({ ...principal, token: `care-${principal.id}-${'x'.repeat(32)}` }));
  const token = (actor: Principal) => credentials.find(entry => entry.id === actor.id)!.token;
  store = await withDatabase('caretaker-report-on-home');
  await store.init();
  http = server(new Engine(store, 7200, 'owner/caretaker'), credentials);
  await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const call = async (bearer: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}/api/${path}`, body === undefined ? { headers: { Authorization: `Bearer ${bearer}`, ...headers } }
      : { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (bearer: string, path: string, body?: unknown, headers?: Record<string, string>) => { const result = await call(bearer, path, body, headers); assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`); return result.body; };

  // A held account, and a compute host that is away as the loop reads it.
  const home = join(await temporaryDirectory('caretaker-home'), 'claude-a'); await mkdir(home, { recursive: true });
  await ok(token(operator), 'agent-registry/apply', { runtimes: [proposedRuntimes.find(runtime => runtime.name === 'claude')], models: [{ name: 'opus', id: 'claude-opus-5' }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: 'care-host', home } }], roles: [{ name: 'caretaker', accounts: ['claude-a'], concurrency: 1 }], reason: 'The caretaker fleet' });
  await ok(token(operator), 'agent-registry/accounts/claude-a/quota', { quota: { state: 'exhausted', resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }, reason: 'You\'ve hit your weekly limit' });
  const held = (await ok(token(operator), 'agent-registry')).accounts.find((account: any) => account.name === 'claude-a');
  assert.notEqual(held.quota, 'available', 'the account starts held');
  await ok(token(coordinator), 'work-snapshot', undefined, { [loopPresenceHeader]: '60',
    [loopHostsHeader]: encodeLoopHosts([{ host: 'gpu-box', away: true, reason: 'ssh: connect to host gpu-box port 22: Connection refused', cores: null, celsius: null, steal: null, runs: null }]) });
  const item = await ok(token(operator), 'work', { title: 'Something to build', why: 'w', simplest: 's', type: 'chore', priority: 2,
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:caretaker-runs-once-per-interval', 'e2e:caretaker-report-on-home'] }], policy: { checks: ['test'], review: true } }) as Work;

  // A stub agent that follows the checklist through the CLI commands the prompt names, with the caretaker's own token file.
  let caretakerToken = '';
  const directory = await temporaryDirectory('caretaker-run'), tokenFile = join(directory, 'caretaker.token');
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, [launcher, ...args], { cwd: directory,
    env: { ...process.env, GRAPHYARD_URL: url, GRAPHYARD_TOKEN_FILE: tokenFile, GRAPHYARD_TOKEN: undefined, GRAPHYARD_REQUEST_ID: undefined } })).stdout);
  const stubAgent = async () => {
    const lines: string[] = [];
    for (const account of (await cli('caretaker', 'registry')).accounts.filter((entry: any) => entry.quota !== 'available')) {
      const answer = 'The live request answered: OK';
      await cli('caretaker', 'registry', 'account', 'quota', account.name, 'available', '--reason', answer);
      lines.push(`fixed: ${account.name} answered a live request; marked available ("${answer}")`);
    }
    for (const host of (await cli('status')).hosts) lines.push(host.away ? `needs the owner: ${host.host} is away: ${host.reason}` : `checked: ${host.host} is ready`);
    lines.push('checked: merges per hour 0.0 over 6h, 0.0 over 24h');
    await cli('caretaker', 'restart', 'the loop stopped dispatching');
    await writeFile(join(directory, 'report.txt'), lines.join('\n'));
    await cli('caretaker', 'report', join(directory, 'report.txt'));
  };
  const loopConfig = config(url, join(await temporaryDirectory('caretaker-credentials'), 'coordinator.token'));
  const effects = {
    snapshot: async () => ok(token(coordinator), 'work-snapshot'), agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), closeSession: () => {},
    persist: async () => {},
    caretaker: async () => {
      caretakerToken = (await ok(token(coordinator), 'caretaker-identity', {})).token;
      await writeFile(tokenFile, `${caretakerToken}\n`, { mode: 0o600 });
      await stubAgent();
      const served = await serveCaretakerRequests(directory, loopConfig, caretakerRequestsFile(tokenFile));
      const report = (await ok(token(coordinator), 'caretaker/reports')).report;
      return { result: `${served}Reported ${report.lines.length} lines: ${report.lines[0]}` };
    },
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(loopConfig);
  await runCycle(loopConfig, state, effects, Date.now, undefined, () => {});

  assert.match(state.caretaker?.result ?? '', /^Loop restart requested\. Reported 3 lines: fixed: claude-a answered a live request/, 'the loop recorded the pass, the restart it served and its result line');
  assert.equal(JSON.parse(await readFile(loopRestartRequestPath(loopConfig), 'utf8')).requestedBy, 'caretaker', 'the caretaker\'s restart is the loop\'s own request');
  const account = (await ok(token(operator), 'agent-registry')).accounts.find((entry: any) => entry.name === 'claude-a');
  assert.equal(account.quota, 'available', 'the held account that answered is available');
  const caretaker = (await ok(caretakerToken, 'status')).actor;
  assert.equal(caretaker.role, 'caretaker');
  assert.ok(![operator.id, coordinator.id].includes(caretaker.id), 'its own principal');

  const report = (await ok(token(operator), 'caretaker/reports')).report;
  assert.ok(report.lines.length <= 12);
  assert.deepEqual(report.needsOwner, ['gpu-box is away: ssh: connect to host gpu-box port 22: Connection refused']);
  const status = await ok(token(operator), 'status');
  const snapshot = await ok(token(operator), 'work-snapshot');
  const dashboard = { token: 'test', work: snapshot.work, status, observedAt: Date.now(), query: '', setQuery: () => {}, setSelected: () => {}, setCreating: () => {}, setView: () => {},
    filter: null, setFilter: () => {}, action: async () => {}, busy: false, api: async () => ({}), board: boardFromStatus(snapshot.work, Date.now(), null) } as unknown as Dashboard;
  const home$ = renderToStaticMarkup(createElement(OverviewPage, dashboard));
  const needsYou = home$.slice(home$.indexOf('data-group-section="needs-you"'));
  assert.ok(home$.includes('data-group-section="needs-you"'), 'Home has a Needs you group');
  assert.match(needsYou.slice(0, needsYou.indexOf('</section>')), /gpu-box is away: ssh: connect to host gpu-box port 22: Connection refused/, 'Home shows the away host under Needs you');

  // Its identity cannot release, close, rework or revise requirements, answer, change roles, or edit code.
  for (const [path, body] of [[`work/${item.id}/requirements`, { reason: 'r', criteria: [] }], [`work/${item.id}/release`, { reason: 'r' }], [`work/${item.id}/close`, { reason: 'r' }],
    [`work/${item.id}/rework`, { reason: 'r' }], [`work/${item.id}/answer`, { answer: 'yes' }], ['agent-registry/roles', { role: { name: 'worker', accounts: ['claude-a'], concurrency: 1 }, reason: 'r' }],
    [`work/${item.id}/claim`, {}]] as const) {
    const refused = await call(caretakerToken, path, body);
    assert.equal(refused.status, 403, `${path} answers 403 to the caretaker: ${JSON.stringify(refused.body)}`);
  }
});
