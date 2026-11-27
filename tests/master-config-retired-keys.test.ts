import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadMasterConfig, masterConfigSchema, masterSettingsFromArgs, saveMasterSettings } from '../src/master.js';
import { masterInit } from '../src/cli/master-init.js';
import type { CliContext } from '../src/cli/context.js';
import { readInstallUnits } from '../src/install/units.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const base = { version: 1, url: 'https://graphyard.example', credentialFile: '/tmp/token', cliPath: '/tmp/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project' };

// A pre-control-plane master.json keeps loading while new installations omit the App ID.
test('unit:master-config-retired-keys — old App and merge settings load and githubAppId is optional', async () => {
  const old = masterConfigSchema.parse({ ...base, mergeMethod: 'squash' });
  assert.equal(old.githubAppId, 1234);
  assert.equal((old as unknown as Record<string, unknown>).mergeMethod, 'squash');
  const { githubAppId, ...withoutApp } = base;
  assert.equal(masterConfigSchema.parse(withoutApp).githubAppId, undefined);
  const directory = await temporaryDirectory('retired-master-config');
  const root = join(directory, 'repo');
  try {
    await mkdir(join(root, '.graphyard'), { recursive: true });
    execFileSync('git', ['init', '--quiet', root]);
    const credentialFile = join(directory, 'master.token');
    await writeFile(credentialFile, 'fixture-master-token-with-no-app-credentials', { mode: 0o600 });
    const file = join(root, '.graphyard/master.json');
    const config = { ...base, credentialFile, cliPath: resolve('bin/graphyard.mjs'), mergeMethod: 'squash' };
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const loaded = await loadMasterConfig(root);
    assert.equal(loaded.githubAppId, 1234);
    assert.equal((loaded as unknown as Record<string, unknown>).mergeMethod, 'squash');
    const { githubAppId: _retired, ...current } = config;
    await writeFile(file, JSON.stringify(current));
    assert.equal((await loadMasterConfig(root)).githubAppId, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('retired autoMerge loads and drops on rewrite', () => {
  const parsed = masterConfigSchema.parse({ ...base, autoMerge: false });
  assert.equal('autoMerge' in parsed, false);
});

// GY-3964: six run settings and the units record's executorTemplate were read by nothing. A stored file still
// carrying them loads with every other field as stored, the two commands that wrote them take them no longer,
// and a rewrite through the schema drops them and changes nothing else.
test('unit:config-with-removed-settings-still-loads — a master.json and a units record still carrying the removed settings load, every other field as stored', async () => {
  const removed = { dispatchIntervalSeconds: 30, deploymentUrl: 'https://graphyard.example/healthz', deploymentShaField: 'commit', deploymentReuseMinutes: 15, proofDispatchGraceMinutes: 5, promoteEveryMinutes: 60 };
  const directory = await temporaryDirectory('removed-run-settings');
  const root = join(directory, 'repo');
  try {
    await mkdir(join(root, '.graphyard'), { recursive: true });
    execFileSync('git', ['init', '--quiet', root]);
    const credentialFile = join(directory, 'master.token');
    await writeFile(credentialFile, 'fixture-master-token-with-removed-run-settings', { mode: 0o600 });
    const stored = { ...base, credentialFile, cliPath: resolve('bin/graphyard.mjs'), herdrWorkspace: 'wF', mergeMethod: 'squash',
      run: { intervalSeconds: 25, smokeWorkflow: 'deploy-smoke.yml', acknowledgementSeconds: 120, ...removed } };
    const file = join(root, '.graphyard/master.json');
    await writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });

    // It loads, a load rewrites nothing, and every other field is as stored.
    const loaded = await loadMasterConfig(root);
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(stored, null, 2), 'a load rewrites nothing');
    for (const [key, value] of Object.entries(stored)) if (key !== 'run') assert.deepEqual((loaded as unknown as Record<string, unknown>)[key], value, key);
    const run = loaded.run as unknown as Record<string, unknown>;
    assert.deepEqual([run.intervalSeconds, run.smokeWorkflow, run.acknowledgementSeconds], [25, 'deploy-smoke.yml', 120]);
    for (const key of Object.keys(removed)) assert.equal(key in run, false, `${key} no longer exists on a loaded config`);

    // A rewrite through the schema drops the six and changes only what it set.
    await saveMasterSettings(root, { intervalSeconds: 30 });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...JSON.parse(JSON.stringify(loaded)), run: { ...run, intervalSeconds: 30 } });

    // `master config` takes none of the six, by name on the command line or as a change handed to the writer.
    for (const key of Object.keys(removed)) assert.throws(() => masterSettingsFromArgs([`${key}=1`]), /changes only what the master owns/, `${key} is no setting master config takes`);
    await assert.rejects(saveMasterSettings(root, { deploymentUrl: 'https://graphyard.example/healthz' } as never), /changes only what the master owns/);
    // `master init` takes none of the flags that wrote them.
    const invocation = (args: string[]) => ({ args, connection: null, base: 'https://graphyard.example', print: () => {} }) as unknown as CliContext;
    for (const flag of ['--dispatch-interval', '--deployment-url', '--deployment-sha-field']) await assert.rejects(masterInit(invocation([flag]), root), /Unknown option/);

    // The units record: one that still names its executor template loads, per-install and legacy alias alike.
    const legacy = { version: 1, slug: null, master: 'graphyard-master.service', alias: true }, perInstall = { version: 1, slug: 'owner-project', master: 'graphyard-master-owner-project.service', alias: false };
    for (const [units, executorTemplate] of [[legacy, 'graphyard-executor@.service'], [perInstall, 'graphyard-executor-owner-project@.service']] as const) {
      await writeFile(join(root, '.graphyard/units.json'), JSON.stringify({ ...units, executorTemplate }, null, 2), { mode: 0o600 });
      assert.deepEqual(readInstallUnits(root), units);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
