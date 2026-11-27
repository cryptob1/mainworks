import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { listen } from './helpers/http-server.js';
import { apiOk } from './helpers/api.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { atomicPrivateWrite, atomicPrivateText } from '../src/master/config.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { readOnlyMountWrapper } from '../src/master/confinement.js';
import { proposedRuntimes } from '../src/model/registry.js';
import { moveInstall } from '../src/install/move.js';
import { fakeTransport } from '../src/install/transport.js';
import { installDirectory } from '../src/install/secrets.js';
import { installIdFor } from '../src/install/types.js';
import { deployUnitOf, proposedInstallUnits, recordInstallUnits } from '../src/install/units.js';

test('integration:install-move-skips-mask-and-never-strands-an-install — the mask file stays behind, an unreadable file changes nothing, a failed copy is undone', async t => {
  const store = await withDatabase('move_skips_mask'); await store.init();
  const admin = 'move-admin-'.padEnd(40, 'a'), token = 'move-coordinator-'.padEnd(40, 'x');
  const { url, close } = await listen(server(new Engine(store, 120, 'owner/project'), [
    { id: 'operator', role: 'admin', sessionKind: 'human', token: admin }, { id: 'coordinator', role: 'coordinator', token }]));
  t.after(async () => { await close(); await store.close(); });
  const scratch = await temporaryDirectory('move-skips-mask');
  const root = join(scratch, 'checkout'), configHome = join(scratch, 'config'), units = join(scratch, 'units');
  const directory = installDirectory(installIdFor('owner/project'), configHome);
  await gitRepo({ root, files: { 'README.md': 'fixture' } });
  await mkdir(join(root, '.graphyard'), { recursive: true }); await mkdir(join(directory, 'postgres'), { recursive: true }); await mkdir(units, { recursive: true });
  const credentialFile = join(configHome, 'coordinator.token');
  await atomicPrivateText(credentialFile, token);
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), masterConfigSchema.parse({ version: 1, url, credentialFile, repository: 'owner/project', baseBranch: 'main',
    cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), hostId: 'old-host', masterAgentName: 'master', workers: [] }));
  const recorded = await recordInstallUnits(root, proposedInstallUnits(root, 'owner/project', units));
  for (const name of [recorded.master, deployUnitOf(recorded)]) await writeFile(join(units, name), '[Service]\n');
  await apiOk(url, admin, 'agent-registry/apply', { body: { runtimes: proposedRuntimes.filter(runtime => runtime.name === 'claude'), models: [{ name: 'default', id: null }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'default', credential: { host: 'old-host', home: null } }], roles: [{ name: 'worker', accounts: ['claude-a'], concurrency: 1 }], reason: 'fixture' } });
  const host = async () => (await apiOk(url, token, 'agent-registry/document')).accounts[0].credential.host as string;
  // The sandbox mask file a confined session leaves in the checkout.
  const mask = join(root, '.graphyard', 'masked');
  await writeFile(mask, '', { mode: 0 }); await chmod(mask, 0);
  // A live listening socket and a FIFO in the copied trees: nothing can copy them, so they stay behind.
  const socket = join(root, 'live.sock'), fifo = join(directory, 'pipe');
  const listening = createServer(); await new Promise<void>(accept => listening.listen(socket, accept)); t.after(() => new Promise<void>(accept => listening.close(() => accept())));
  execFileSync('mkfifo', [fifo]);

  const recorder = () => {
    const calls: { kind: 'stop' | 'start'; commands: string[]; host: string; copied: boolean }[] = [];
    let target = '';
    const record = (kind: 'stop' | 'start') => async (commands: string[][]) => { calls.push({ kind, commands: commands.map(command => command.join(' ')), host: await host(), copied: existsSync(join(target, root, 'README.md')) }); };
    return { calls, into: (into: string) => { target = into; return { configHome, unitDirectory: units, stop: record('stop'), start: record('start'), transport: fakeTransport() }; } };
  };

  // An unreadable file outside the mask: refused in one line naming it, before anything is stopped or re-pointed.
  const secret = join(root, 'secret.txt');
  await writeFile(secret, 'x', { mode: 0 }); await chmod(secret, 0);
  const refused = recorder(), refusedTarget = join(scratch, 'refused');
  await assert.rejects(moveInstall(root, { to: 'new-host', into: refusedTarget }, refused.into(refusedTarget)), (error: Error) => {
    assert.match(error.message, new RegExp(`^Nothing was moved: the move cannot read ${secret};`)); assert.ok(!error.message.includes(mask), 'the mask file is not named');
    assert.ok(!error.message.includes('\n')); return true;
  });
  assert.deepEqual(refused.calls, [], 'nothing was stopped'); assert.equal(existsSync(refusedTarget), false, 'nothing was copied');
  assert.equal(await host(), 'old-host', 'no account was re-pointed');
  await chmod(secret, 0o600);

  // A copy that fails midway (the install directory's place on the target is taken): the stopped loop is started again, the accounts stay on the old host.
  const failed = recorder(), failedTarget = join(scratch, 'failed');
  await mkdir(dirname(join(failedTarget, directory)), { recursive: true }); await writeFile(join(failedTarget, directory), 'in the way');
  await assert.rejects(moveInstall(root, { to: 'new-host', into: failedTarget }, failed.into(failedTarget)), /The move to new-host failed: .*Undone: started .*-master-.*-deploy-.* again; the install still runs on old-host$/s);
  assert.ok(existsSync(join(failedTarget, root, 'README.md')), 'the checkout was copied before the failure');
  assert.deepEqual(failed.calls.map(call => call.kind), ['stop', 'start']);
  assert.ok(failed.calls[0]!.commands.length > 0 && failed.calls[0]!.commands.every(command => !command.includes('-local-')), 'only the loop was stopped: the control plane stays up');
  assert.deepEqual(failed.calls[1]!.commands, failed.calls[0]!.commands.map(command => command.replace(' stop ', ' start ')), 'what was stopped is started again');
  assert.equal(await host(), 'old-host', 'the accounts still point at the old host');

  // The mask file stays behind; the accounts are re-pointed only after every file is copied, and the control plane is stopped last.
  const moved = recorder(), target = join(scratch, 'target');
  const result = await moveInstall(root, { to: 'new-host', into: target }, moved.into(target));
  assert.equal(result.applied, true);
  assert.equal(result.skipped, `Left behind 2 socket, FIFO or device files, which nothing can copy: ${socket}, ${fifo}`);
  assert.equal(existsSync(join(target, socket)) || existsSync(join(target, fifo)), false, 'the socket and the FIFO are not copied');
  assert.equal(existsSync(join(target, mask)), false, 'the mask file is not copied');
  assert.deepEqual(moved.calls.map(call => [call.kind, call.host, call.copied]), [['stop', 'old-host', false], ['stop', 'new-host', true]]);
  assert.ok(moved.calls[1]!.commands.every(command => command.includes('-local-')), 'the control plane stops after the re-point');
  assert.equal(await host(), 'new-host');
  // The moved install's first confined launch recreates the mask file.
  readOnlyMountWrapper({ coordinatorRoot: join(target, root), sessionDirectory: join(target, root), secretsBus: null, credentialMask: { configHome: join(target, configHome), extraPaths: [], own: [], cli: [] } });
  assert.equal((await stat(join(target, mask))).mode & 0o777, 0, 'the moved install recreates the mask file on first launch');
});
