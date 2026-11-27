import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';
import { listen } from './helpers/http-server.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { atomicPrivateWrite, atomicPrivateText, loadMasterConfig } from '../src/master/config.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { loopStateClient, type LoopStateKind } from '../src/loop-state.js';
import { moveInstall } from '../src/install/move.js';
import { fakeTransport } from '../src/install/transport.js';
import { installDirectory } from '../src/install/secrets.js';
import { installIdFor } from '../src/install/types.js';

test('integration:move-keeps-loop-ledgers — a move and credential rename retain the legacy review, producer and dispatch scope', async t => {
  const store = await withDatabase('move_loop_ledgers'); await store.init();
  const token = 'move-coordinator-'.padEnd(40, 'x');
  const { url, close } = await listen(server(new Engine(store, 120, 'owner/project'), [{ id: 'coordinator', role: 'coordinator', token }]));
  t.after(async () => { await close(); await store.close(); });
  const scratch = await temporaryDirectory('move-loop-ledgers');
  const root = join(scratch, 'checkout'), configHome = join(scratch, 'config'), target = join(scratch, 'target');
  await gitRepo({ root, files: { 'README.md': 'fixture' } });
  await mkdir(join(root, '.graphyard'), { recursive: true });
  await mkdir(join(installDirectory(installIdFor('owner/project'), configHome), 'postgres'), { recursive: true });
  const credentialFile = join(configHome, 'coordinator.token');
  await atomicPrivateText(credentialFile, token);
  const config = masterConfigSchema.parse({ version: 1, url, credentialFile, repository: 'owner/project', baseBranch: 'main',
    cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), hostId: 'old-host', masterAgentName: 'master', workers: [] });
  const masterFile = join(root, '.graphyard/master.json');
  await atomicPrivateWrite(masterFile, config);
  // Write using the pre-upgrade config, before any loader has persisted a stable scope.
  const client = await loopStateClient(config), at = new Date().toISOString();
  const common = { key: 'GY-1', pr: 1, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1,
    profile: 'fixture', agentName: 'in-flight', pane: null, requestedAt: at, state: 'pending' };
  await client.write('reviews', [{ ...common, id: randomUUID(), sessionDirectory: '/review', tokenExpiresAt: at }]);
  await client.write('producers', [{ ...common, id: randomUUID(), requestId: 'proof-request', principal: 'producer', group: 'integration', proofs: ['integration:fixture'], expiresAt: at }]);
  await client.write('dispatch', [{ version: 1, url, repository: config.repository, ticks: 17 }]);
  const kinds: LoopStateKind[] = ['reviews', 'producers', 'dispatch'];
  const before = await Promise.all(kinds.map(kind => client.read(kind)));
  const legacyScope = createHash('sha256').update(`${config.repository}\n${config.hostId}\n${credentialFile}`).digest('hex');
  assert.deepEqual((await store.pool.query('SELECT DISTINCT scope FROM loop_state')).rows, [{ scope: legacyScope }]);

  // Move an old install without first loading it through the upgraded config loader.
  const moved = await moveInstall(root, { to: 'new-host', into: target }, { configHome, unitDirectory: join(scratch, 'units'), stop: async () => {}, transport: fakeTransport() });
  assert.equal(moved.applied, true);
  const movedRoot = join(target, root), movedFile = join(movedRoot, '.graphyard/master.json');
  const movedConfig = await loadMasterConfig(movedRoot);
  assert.equal(movedConfig.hostId, 'new-host');
  const movedClient = await loopStateClient(movedConfig);
  assert.deepEqual(await Promise.all(kinds.map(kind => movedClient.read(kind))), before, 'every in-flight ledger record survives the host move');

  // The unchanged source upgrades in place and continues to use exactly its old scope.
  const unchanged = await loopStateClient(await loadMasterConfig(root));
  assert.deepEqual(await Promise.all(kinds.map(kind => unchanged.read(kind))), before);
  const stored = JSON.parse(await readFile(masterFile, 'utf8'));
  assert.equal(stored.loopStateScope, legacyScope);
  assert.equal(JSON.parse(await readFile(movedFile, 'utf8')).loopStateScope, legacyScope);
  const renamed = join(configHome, 'renamed.token');
  await rename(credentialFile, renamed);
  await atomicPrivateWrite(masterFile, { ...stored, credentialFile: renamed });
  const renamedClient = await loopStateClient(root);
  assert.deepEqual(await Promise.all(kinds.map(kind => renamedClient.read(kind))), before, 'the root-based client retains ledgers after a credential rename');
  const reloadedClient = await loopStateClient(await loadMasterConfig(root));
  assert.deepEqual(await Promise.all(kinds.map(kind => reloadedClient.read(kind))), before, 'the config-based client retains ledgers too');
});
