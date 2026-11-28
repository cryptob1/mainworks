import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployOnce, deployRecordPath, controlPlaneRecordPath, readControlPlaneRecord } from '../src/deploy-watch.js';
import { deployPorts } from './helpers/deploy-ports.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withEnv } from './helpers/env.js';

const previous = 'a'.repeat(40), next = 'b'.repeat(40), blob = `sha256:042822a3${'c'.repeat(56)}`;
// GY-4052: isolate the image lock from the host's real lock and sibling tests in the same smoke step.
process.env.MAINWORKS_LOCK_ROOT = await temporaryDirectory('bad-blob-locks');
for (const failure of ['lease does not exist: not found', 'failed to ingest']) {
  test(`integration:deploy-build-recovers-from-bad-blob — ${failure} retries this build once without cache and names the blob`, { timeout: 15_000 }, async () => {
    const root = await temporaryDirectory('bad-blob');
    const builds: boolean[] = [];
    let serving = previous;
    const ports = deployPorts(next, previous, {
      restart: async (commit, options?: { noCache?: boolean }) => {
        if (commit === next) {
          builds.push(options?.noCache ?? false);
          if (!options?.noCache) throw new Error(`failed to ingest blob ${blob}: ${failure}`);
        }
        serving = commit;
      },
      health: async commit => { assert.equal(serving, commit); },
      install: 'core',
    });
    assert.equal(await deployOnce(deployRecordPath(root), ports, () => {}), 'deployed');
    assert.deepEqual(builds, [false, true]);
    const status = readControlPlaneRecord(controlPlaneRecordPath(root));
    assert.equal(status?.commit, next);
    assert.match(status?.retried ?? '', /without.*cache/);
    assert.ok(status?.retried?.includes(blob));
  });
}

test('integration:deploy-build-recovers-from-bad-blob — recovery passes --no-cache to both Docker builds without pruning host resources', async () => {
  const { composeAdapter } = await import('../src/install/adapters.js');
  const root = await temporaryDirectory('bad-blob-docker');
  const commands: string[][] = [];
  await withEnv({ MAINWORKS_BUILD_NO_CACHE: '1' }, async () => {
    await composeAdapter.provision({
      sourceRoot: root, image: 'mainworks-local:bbbbbbbbbbbb',
      transport: {
        description: 'fake Docker', putFile: async () => {},
        exec: async (program: string, args: string[]) => {
          commands.push([program, ...args]);
          return { code: args[0] === 'image' && args[1] === 'inspect' ? 1 : 0, stdout: '', stderr: '' };
        },
      },
    } as unknown as import('../src/install/adapters.js').AdapterContext, {} as never);
    const builds = commands.filter(args => args[0] === 'docker' && (args[1] === 'build' || args[2] === 'build'));
    assert.equal(builds.length, 2);
    assert.ok(builds.every(args => args.includes('--no-cache')));
    assert.ok(commands.filter(args => args[0] === 'docker').every(args => !args.some(arg => ['prune', 'rm', 'rmi', 'remove'].includes(arg))));
  });
});
