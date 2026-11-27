import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gateRecordPath, readGateRecord } from '../src/batch-gate.js';
import { deployOnce, deployRecordPath, writeControlPlaneRecord, controlPlaneRecordPath } from '../src/deploy-watch.js';
import { masterStatusReport, npmPublishedVersion } from '../src/cli/master-status.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { publishedVersion } from '../src/release.js';
import { mainworksRepository } from '../src/scenarios.js';
import { gateFixture, runGit as git } from './helpers/publish-tag-fixture.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

test('unit:tests/publish-tag.test.ts — a verified deploy pushes exactly one version tag with the deploy key, including across restart', async () => {
  const f = await gateFixture();
  await f.gate();
  const commit = await f.merge(); await f.gate();
  assert.equal(readGateRecord(gateRecordPath(f.coordinator))!.verified, commit);
  const pushes = () => f.calls.filter(call => call.args.includes('push'));
  assert.equal(pushes().length, 0, 'verification alone must not publish');
  await f.deploy(commit, { reason: 'health failed; kept because schema changed' }); await f.gate();
  assert.equal(pushes().length, 0, 'a kept unhealthy deployment must not publish');
  await f.deploy(commit, { repository: 'owner/other' }); await f.gate();
  assert.equal(pushes().length, 0, 'another repository is not Mainworks deployment evidence');
  await f.deploy(commit); f.restart(); await f.gate();
  const tag = `v${publishedVersion(commit, new Date(Number(git(f.coordinator, ['show', '-s', '--format=%ct', commit])) * 1000))}`;
  assert.equal(pushes().length, 1);
  assert.deepEqual(pushes()[0]!.args, ['-C', f.coordinator, 'push', 'origin', `${commit}:refs/tags/${tag}`]);
  assert.match(pushes()[0]!.env!.GIT_SSH_COMMAND!, new RegExp(`ssh -i ${f.deployKey} `));
  assert.equal(pushes()[0]!.env!.GITHUB_TOKEN, undefined);
  assert.equal(git(f.origin, ['rev-parse', `refs/tags/${tag}`]), commit);
  assert.equal(readGateRecord(gateRecordPath(f.coordinator))!.releaseTagged, commit);
  for (let i = 0; i < 3; i++) { f.restart(); await f.gate(); }
  assert.equal(pushes().length, 1, 'the durable handoff prevents repeated pushes each cycle/restart');
  const next = await f.merge(); await f.gate();
  assert.equal(pushes().length, 1, 'a later verification still waits for deployment');
  await f.deploy(next); await f.gate();
  assert.equal(pushes().length, 2);
});

test('unit:tests/publish-tag.test.ts — a successful deploy remains eligible when verification advances before the loop observes it', async () => {
  const f = await gateFixture();
  await f.gate();
  const commit = await f.merge(); await f.gate();
  const steps: string[] = [];
  assert.equal(await deployOnce(deployRecordPath(f.coordinator), {
    fetch: async () => commit, head: async () => git(f.coordinator, ['rev-parse', 'HEAD']),
    build: async () => { steps.push('build'); }, restart: async () => { steps.push('restart'); },
    health: async () => { steps.push('health'); }, checkout: async () => { steps.push('checkout'); }, pin: async () => { steps.push('pin'); },
    prune: async () => {}, schema: async () => 1, database: async () => 1,
  }, () => {}, mainworksRepository), 'deployed');
  assert.deepEqual(steps, ['build', 'restart', 'health', 'checkout', 'pin']);
  // Simulate a gate that finished while deploy was completing and before its next observation.
  const later = await f.merge();
  const file = gateRecordPath(f.coordinator), record = readGateRecord(file)!;
  await writeFile(file, JSON.stringify({ ...record, verified: later }));
  f.restart(); await f.gate();
  const pushes = f.calls.filter(call => call.args.includes('push'));
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0]!.args.at(-1)!.startsWith(`${commit}:refs/tags/v`));
});

test('unit:tests/publish-tag.test.ts — other installations never push Mainworks release tags', async () => {
  const f = await gateFixture('owner/project');
  await f.gate(); const commit = await f.merge(); await f.gate(); await f.deploy(commit); await f.gate();
  assert.equal(f.calls.filter(call => call.args.includes('push')).length, 0);
});

test('unit:tests/publish-tag.test.ts — the release workflow is tag-only, uses OIDC and runs the shared publisher without npm secrets', () => {
  const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
  assert.match(workflow, /on:\n  push:\n    tags: \['v\*'\]\npermissions:/);
  assert.doesNotMatch(workflow, /workflow_dispatch|pull_request|branches:|NPM_TOKEN|NODE_AUTH_TOKEN/);
  for (const permission of ['contents: read', 'id-token: write', 'packages: write']) assert.ok(workflow.includes(permission));
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['GITHUB_TOKEN']);
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /npm install --global npm@11\.5\.2/);
  assert.match(workflow, /docker\/setup-buildx-action@/);
  assert.match(workflow, /concurrency:\n  group: publish\n  queue: max/);
  assert.match(workflow, /node scripts\/build-publisher\.mjs/);
  assert.match(workflow, /node scripts\/publish-verified\.mjs --provenance/);
  assert.match(workflow, /GRAPHYARD_PUBLISH_COMMIT: \$\{\{ github.sha \}\}/);
  // Inspect every production source file, not just the former caller, for the retired token path.
  const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' }).trim().split('\n');
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), /publishTokenFiles|npm-token|ghcr-token/, file);
  assert.doesNotMatch(readFileSync('src/daemon/cycle-merge-writer.ts', 'utf8'), /publishVerified/);
  assert.doesNotMatch(readFileSync('src/daemon/cycle-batch-gate.ts', 'utf8'), /publishVerified|Publishing Mainworks for npx/);
});

test('unit:tests/publish-tag.test.ts — status shows npm latest beside the control plane commit even when managing another repository', async () => {
  const root = await temporaryDirectory('publish-status'), commit = 'a'.repeat(40), version = '2026.11.10-aaaaaaaaaaaa';
  await writeControlPlaneRecord(controlPlaneRecordPath(root), { commit });
  const config = { url: 'http://127.0.0.1:5', repository: 'owner/project', credentialFile: join(root, 'credential'), hostId: 'test', baseBranch: 'main', workers: [], run: { intervalSeconds: 30 } } as unknown as MasterConfig;
  const report = await masterStatusReport(root, config, async () => ({ work: [], now: new Date().toISOString() }), async (command, args) => {
    if (command === 'npm') { assert.deepEqual(args, ['view', '@cryptob1/graphyard', 'version', '--json', '--registry=https://registry.npmjs.org/']); return JSON.stringify(version); }
    return '';
  });
  assert.equal(report.controlPlaneUpdate!.commit, commit.slice(0, 12));
  assert.equal(report.controlPlaneUpdate!.publishedVersion, version);
  assert.equal(report.serving.commit, null, 'Mainworks release is not the managed project release');
  assert.equal(await npmPublishedVersion(async () => { throw new Error('E404'); }), 'not published');
  assert.equal(await npmPublishedVersion(async () => { throw new Error('offline'); }), 'unavailable');
});
