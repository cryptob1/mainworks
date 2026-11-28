import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';
import type { Store } from '../src/store.js';
import { ensureTokens, installDirectory, plannedPrincipals, prepareInstallDirectory, tokenFile, Vault, writeInstallRecord } from '../src/install/secrets.js';
import { loadMasterConfig, setupMaster } from '../src/master/config.js';
import { caretakerInboxDirectory } from '../src/master/caretaker.js';
import { credentialMaskFor, masterCredentialMask, readOnlyMountWrapper } from '../src/master/confinement.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { listen } from './helpers/http-server.js';
import { apiOk } from './helpers/api.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const runCli = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) =>
  exec(process.execPath, [cli, ...args], { cwd: options.cwd, env: options.env, encoding: 'utf8' })
    .then(({ stdout, stderr }) => ({ status: 0, stdout, stderr }), (error: any) => ({ status: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }));
const closers: (() => Promise<void>)[] = [];
after(async () => { for (const close of closers.reverse()) await close(); });

test('integration:brief-delivers-to-inbox — install creates inbox readable by Lead and caretaker, mainworks brief copies file (refusing > 1 MB) and sends one Lead input naming it', async () => {
  await mkdir(join(process.cwd(), '.graphyard'), { recursive: true });
  const scratch = await temporaryDirectory('brief-inbox', join(process.cwd(), '.graphyard'));
  const root = await temporaryDirectory('repo', scratch);
  const configHome = await temporaryDirectory('config', scratch);
  (await gitRepo({ root, files: { 'README.md': 'Fixture.\n' } })).git('remote', 'add', 'origin', 'https://github.com/owner/factory.git');

  // 1. Install prepares <install config>/inbox/.
  const installId = 'owner-factory';
  const dir = installDirectory(installId, configHome);
  await prepareInstallDirectory(dir, root);
  const inbox = join(dir, 'inbox');
  const inboxStat = await stat(inbox);
  assert.ok(inboxStat.isDirectory(), 'install creates <install config>/inbox/');
  assert.equal(inboxStat.mode & 0o777, 0o700);

  // Set up install tokens, install.json, and control plane.
  const principals = plannedPrincipals(installId, { workers: 1 });
  const vault = new Vault();
  const tokens = await ensureTokens(dir, principals, vault);
  const operator = principals.find(p => p.role === 'admin' && p.sessionKind === 'human')!;
  const coordinator = principals.find(p => p.role === 'coordinator')!;
  const serverPrincipals: (Principal & { token: string })[] = principals.map(p => ({ id: p.id, role: p.role, ...(p.sessionKind ? { sessionKind: p.sessionKind } : {}), token: tokens.get(p.id)! }));

  const store: Store = await withDatabase('brief_delivers_to_inbox');
  await store.init();
  const plane = await listen(server(new Engine(store, 120, 'owner/factory'), serverPrincipals));
  closers.push(async () => { await plane.close(); await store.close(); });

  await writeInstallRecord(dir, {
    version: 1, installId, repository: 'owner/factory', provider: 'local', selfContained: true,
    migratedFrom: null, baseBranch: 'main', reviewPolicy: 'agent', domain: null, service: null,
    url: plane.url, deployment: null,
    principals: principals.map(p => ({ id: p.id, role: p.role, ...(p.sessionKind ? { sessionKind: p.sessionKind } : {}), fingerprint: 'a'.repeat(12) })),
    github: null, noGithubApp: true, merger: 'control-plane', reviewers: [], profiles: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }, vault);

  await setupMaster(root, {
    url: plane.url, token: tokens.get(coordinator.id)!, cliPath: cli,
    credentialDirectory: dir,
    run: { worktreeRoot: await temporaryDirectory('worktrees', scratch) },
  });
  const config = await loadMasterConfig(root);

  // 2. Both Lead and caretaker confinements keep <install config>/inbox/ readable.
  const leadMask = masterCredentialMask(config, [], configHome);
  assert.ok(!leadMask.hostPaths?.includes(dir), 'Lead keeps its own install directory (including inbox) readable');
  assert.ok(!leadMask.hostPaths?.includes(inbox), 'Lead does not mask its own inbox');

  const caretakerDir = join(dir, 'tokens', 'caretaker');
  await mkdir(caretakerDir, { recursive: true, mode: 0o700 });
  assert.equal(caretakerInboxDirectory(config), inbox, 'caretaker resolves the install inbox beside tokens');
  const caretakerMask = credentialMaskFor(config, { credentialFile: caretakerDir, readonly: [caretakerInboxDirectory(config)] }, configHome);
  const caretakerWrapper = readOnlyMountWrapper({ coordinatorRoot: root, sessionDirectory: root, credentialMask: caretakerMask });
  const maskIdx = caretakerWrapper.findIndex((word, i) => word === '--tmpfs' && caretakerWrapper[i + 1] === configHome);
  const inboxBindIdx = caretakerWrapper.findIndex((word, i) => word === '--ro-bind' && caretakerWrapper[i + 1] === inbox && caretakerWrapper[i + 2] === inbox);
  assert.ok(maskIdx >= 0, 'caretaker masks configHome');
  assert.ok(inboxBindIdx > maskIdx, 'caretaker re-exposes <install config>/inbox/ read-only after the configHome mask');

  // 3. Files over 1 MB are refused before copying or messaging.
  const tooBig = join(scratch, 'huge.bin');
  await writeFile(tooBig, Buffer.alloc(1024 * 1024 + 1, 0x41));
  const refused = await runCli(['brief', tooBig, '--install', installId], {
    cwd: scratch, env: { ...process.env, MAINWORKS_CONFIG_HOME: configHome },
  });
  assert.notEqual(refused.status, 0, 'files over 1 MB must be refused');
  assert.match(refused.stderr + refused.stdout, /1 MB/i);
  assert.deepEqual(await readdir(inbox), [], 'refused file is not copied to inbox');

  // 4. mainworks brief FILE --install NAME copies the file to inbox and sends one Lead input naming it.
  const briefFile = join(scratch, 'launch-plan.md');
  const briefContent = '# Launch plan\nShip the inbox brief command.\n';
  await writeFile(briefFile, briefContent, 'utf8');

  const delivered = await runCli(['brief', briefFile, '--install', installId], {
    cwd: scratch, env: { ...process.env, MAINWORKS_CONFIG_HOME: configHome },
  });
  assert.equal(delivered.status, 0, delivered.stderr || delivered.stdout);
  const result = JSON.parse(delivered.stdout);
  assert.ok(typeof result.path === 'string' && result.path.startsWith(`${inbox}/`), `delivered path should be under ${inbox}: ${delivered.stdout}`);

  const files = await readdir(inbox);
  assert.equal(files.length, 1, 'exactly one file copied to inbox');
  const deliveredPath = join(inbox, files[0]!);
  assert.equal(result.path, deliveredPath);
  assert.equal(await readFile(deliveredPath, 'utf8'), briefContent);
  assert.equal((await stat(deliveredPath)).mode & 0o777, 0o600);

  // The control plane recorded one message and the loop delivers one Lead input naming the delivered path.
  const api = (path: string, body?: unknown) => apiOk(plane.url, tokens.get(coordinator.id)!, path, { body });
  const messages = (await api('master/messages')).messages;
  assert.equal(messages.length, 1);
  assert.ok(messages[0].text.includes(deliveredPath), `message should name ${deliveredPath}: ${messages[0].text}`);

  const state = emptyDaemonState(config);
  const inputs: string[] = [];
  const effects: DaemonEffects = {
    snapshot: () => api('work-snapshot'),
    agents: () => [{ name: config.masterAgentName, pane_id: 'factory:master', agent: 'claude', agent_status: 'idle' }],
    credentials: async () => ({}),
    closeSession: () => {},
    dispatch: async () => undefined,
    persist: async () => {},
    masterMessages: async () => (await api('master/messages')).messages,
    masterSession: {
      wake: async (_pane, text) => { inputs.push(text); },
      launch: async () => { throw new Error('the Lead session is live'); },
    },
  };
  for (let cycle = 0; cycle < 3; cycle++) await runCycle(config, state, effects);
  const woke = inputs.filter(input => input.includes(deliveredPath));
  assert.equal(woke.length, 1, `expected exactly one Lead input naming ${deliveredPath}, got: ${JSON.stringify(inputs)}`);
  assert.match(woke[0]!, /from the owner .*brief delivered to the install inbox/i);
  assert.ok(tokenFile(dir, operator.id));

  // 5. mainworks brief FILE without --install resolves the install from the checkout.
  const secondFile = join(scratch, 'followup.md');
  await writeFile(secondFile, 'Followup brief.\n', 'utf8');
  const deliveredDefault = await runCli(['brief', secondFile], {
    cwd: root, env: { ...process.env, MAINWORKS_CONFIG_HOME: configHome },
  });
  assert.equal(deliveredDefault.status, 0, deliveredDefault.stderr || deliveredDefault.stdout);
  const secondResult = JSON.parse(deliveredDefault.stdout);
  assert.ok(secondResult.path.startsWith(`${inbox}/`));
  assert.equal(await readFile(secondResult.path, 'utf8'), 'Followup brief.\n');
});
