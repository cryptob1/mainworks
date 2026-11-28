import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { composeAdapter, type AdapterContext } from '../src/install/adapters.js';
import { fakeTransport, localTransport } from '../src/install/transport.js';
import { provisionTrialImage } from '../src/install/trial-image.js';
import { deployOnce, deployRecordPath, readDeployRecord } from '../src/deploy-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { deployPorts } from './helpers/deploy-ports.js';
import { withEnv } from './helpers/env.js';
import { slotsDirectoryVariable } from '../src/master/verification-slots.js';

const previous = 'a'.repeat(40), next = 'b'.repeat(40);
const pipe = 'ERROR: failed to build: failed to solve: rpc error: code = Unknown desc = io: read/write on closed pipe';

for (const [name, failures, expected, attempts] of [
  ['clean build', [], 'deployed', 1],
  ['one closed pipe', [pipe], 'deployed', 2],
  ['persistent closed pipe', [pipe, pipe], 'rolled-back', 2],
  ['other Docker error', ['ERROR: failed to solve: no space left on device'], 'rolled-back', 1],
] as const) test(`e2e:compose-deploy-survives-image-export-pipe-error — ${name}`, async () => {
  const root = await temporaryDirectory('compose-export');
  let builds = 0, loads = 0, serving = previous;
  const transport = fakeTransport({ responses: [
    { match: 'mktemp', result: `${root}/image-export\n` },
    { match: 'docker buildx build', result: () => {
      const error = failures[builds++];
      return { code: error ? 1 : 0, stdout: '', stderr: error ?? '' };
    } },
    { match: 'docker load', result: () => { loads++; return ''; } },
  ] });
  await withEnv({ MAINWORKS_LOCK_ROOT: root, [slotsDirectoryVariable]: join(root, 'slots') }, async () => {
    const ports = deployPorts(next, previous, {
      restart: async commit => {
        if (commit === next) await composeAdapter.provision({ sourceRoot: root, transport, image: 'mainworks-local:proof' } as AdapterContext, {} as never);
        serving = commit;
      },
      health: async commit => { assert.equal(serving, commit); },
    });
    assert.equal(await deployOnce(deployRecordPath(root), ports, () => {}), expected);
  });
  assert.equal(builds, attempts, 'at most one retry of the exact pipe error');
  assert.equal(serving, expected === 'deployed' ? next : previous);
  assert.equal(loads, expected === 'deployed' ? 1 : 0, 'only a completed archive is loaded');
  const calls = transport.commands.map((_, index) => transport.line(index));
  assert.ok(calls.some(line => line.includes('--output type=docker,dest=') && !line.includes('--load')), 'export a Docker archive without a live importer pipe');
  assert.ok(calls.some(line => line.startsWith('rm -rf ') && line.includes('/image-export')), 'remove the archive after success or failure');
  if (expected === 'rolled-back') assert.ok(readDeployRecord(deployRecordPath(root))?.reason?.includes(failures[0]!), 'keep Docker’s own error sentence');
});

// Real exporter/importer proof. The transport only substitutes an isolated tag and skips
// builder discovery: the trial uses its own already-provisioned builder, or Docker's default.
test('e2e:compose-deploy-survives-image-export-pipe-error — Docker exports and loads a new revision', async () => {
  const root = await temporaryDirectory('compose-export-docker'), real = localTransport();
  const tag = `mainworks-export-proof:${process.pid}`;
  const transport = { ...real, async exec(program: string, args: string[], options?: Parameters<typeof real.exec>[2]) {
    if (program === 'docker' && args[0] === 'buildx' && args[1] === 'inspect') return { code: 0, stdout: '', stderr: '' };
    if (program === 'docker' && args[0] === 'buildx' && args[1] === 'build') {
      args = [...args];
      args.splice(args.indexOf('--builder'), 2);
      args[args.indexOf('--tag') + 1] = tag;
    }
    return real.exec(program, args, options);
  } };
  try {
    for (const revision of [previous, next]) {
      await writeFile(join(root, 'Dockerfile'), `FROM scratch AS trial\nLABEL org.opencontainers.image.revision=${revision}\nCOPY revision /revision\n`);
      await writeFile(join(root, 'revision'), revision);
      await provisionTrialImage({ sourceRoot: root, transport }, null);
      const loaded = await real.exec('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', tag]);
      assert.equal(loaded.stdout.trim(), revision, 'the new image is loaded into Docker, not left in the builder cache');
    }
  } finally { await real.exec('docker', ['image', 'rm', tag], { allowFailure: true }); }
});
