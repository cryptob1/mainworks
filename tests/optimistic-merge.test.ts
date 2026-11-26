import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';

/**
 * GY-1233: optimistic merge (GY-500) and its main guard are removed. GitHub delivery merges every
 * passing candidate, so nothing lands past the queue, nothing reads a post-merge verdict and nothing
 * is reverted. A master.json written while they ran still loads.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));

test('unit:optimistic-merge-removed — a master.json carrying mergeQueue.optimistic still loads', async () => {
  const root = await temporaryDirectory('optimistic-removed');
  const credentials = await temporaryDirectory('optimistic-removed-credentials');
  try {
    (await gitRepo({ root, files: { 'README.md': 'first\n' }, message: 'first' })).git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
    const credentialFile = join(credentials, 'coordinator.token');
    await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    // As onboarding and operators wrote it while optimistic merge ran (GY-500, GY-503).
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await writeFile(join(root, '.graphyard/master.json'), JSON.stringify({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
      repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
      mergeQueue: { rerunFailedChecks: 2, parallelTips: 4, optimistic: true, optimisticExclude: ['**/package.json', 'tests/helpers/'] } }), { mode: 0o600 });
    const master = await loadMasterConfig(root);
    assert.equal(master.mergeQueue, undefined, 'the config loads and drops its retired queue settings');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  }
});
