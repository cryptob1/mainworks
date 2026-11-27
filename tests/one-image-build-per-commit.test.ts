import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { composeAdapter, type AdapterContext } from '../src/install/adapters.js';
import type { Transport } from '../src/install/transport.js';
import { deployOnce, readDeployRecord } from '../src/deploy-watch.js';
import { deployPorts } from './helpers/deploy-ports.js';

// GY-3710: two installs on one host that deploy the same commit at once run one image build;
// the second waits for the first and reuses its image.

/** One Docker host: `docker build` takes a while and fails when another build of the same tag runs. */
function dockerHost(locks: string) {
  const images = new Set<string>(), building = new Set<string>(), builds: string[] = [], lockedBuilds: boolean[] = [];
  const transport: Transport = {
    description: 'one docker host',
    async exec(program, args) {
      const tagged = args.indexOf('--tag');
      if (program === 'docker' && args[0] === 'build') {
        const tag = args[tagged + 1]!;
        if (building.has(tag)) throw new Error(`docker build ${tag}: failed to export image: content digest not found`);
        building.add(tag); builds.push(tag); lockedBuilds.push(existsSync(join(locks, 'graphyard-local-images.lock')));
        await delay(50);
        building.delete(tag); images.add(tag);
      }
      if (program === 'docker' && args[0] === 'image' && args[1] === 'inspect') return { stdout: '', stderr: '', code: images.has(args[2]!) ? 0 : 1 };
      return { stdout: '', stderr: '', code: 0 };
    },
    async putFile() {},
  };
  return { transport, images, builds, lockedBuilds };
}

/** An install on that host: its own deploy record and lock, a restart that provisions the commit's image and serves it. */
async function install(host: ReturnType<typeof dockerHost>, log: string[], name: string, from: string, to: string) {
  const directory = await temporaryDirectory(`one-image-build-${name}`), state = { serving: from };
  const ports = deployPorts(to, from, {
    restart: async commit => {
      const image = `graphyard-local:${commit.slice(0, 12)}`;
      await composeAdapter.provision({ sourceRoot: directory, image, transport: host.transport } as unknown as AdapterContext, {} as never);
      if (!host.images.has(image)) throw new Error(`${image} is missing`);
      state.serving = commit;
    },
    health: async commit => { if (state.serving !== commit) throw new Error(`/healthz answers ${state.serving.slice(0, 7)}`); },
  });
  return { file: join(directory, '.graphyard', 'deploy.json'), ports, state, log: (line: string) => log.push(`${name}: ${line}`) };
}

test('integration:one-image-build-per-commit — two installs on one host deploying the same commit at once run one image build: the second waits and reuses it, both serve the commit; a commit without an image is built as today', async () => {
  const from = randomBytes(20).toString('hex'), to = randomBytes(20).toString('hex'), other = randomBytes(20).toString('hex');
  process.env.GRAPHYARD_VERSION = '2026.11.23'; process.env.GRAPHYARD_BUILD_REVISION = to;
  // GY-4040: the test's own lock directory, so it never waits on or holds the host's image lock that real deploys take.
  const locks = process.env.MAINWORKS_LOCK_ROOT = await temporaryDirectory('one-image-build-locks');
  try {
    const host = dockerHost(locks), log: string[] = [];
    const mainworks = await install(host, log, 'mainworks', from, to), huck = await install(host, log, 'huck', from, to);
    const outcomes = await Promise.all([mainworks, huck].map(one => deployOnce(one.file, one.ports, one.log)));
    assert.deepEqual(host.builds, [`graphyard-local:${to.slice(0, 12)}`], 'one image build for the commit');
    assert.deepEqual(outcomes, ['deployed', 'deployed'], log.join('\n'));
    assert.equal(mainworks.state.serving, to);
    assert.equal(huck.state.serving, to);
    assert.equal(readDeployRecord(mainworks.file)?.tip, to);
    assert.equal(readDeployRecord(huck.file)?.tip, to);

    // A commit whose image does not exist is built as today.
    process.env.GRAPHYARD_BUILD_REVISION = other;
    const third = await install(host, log, 'third', to, other);
    assert.equal(await deployOnce(third.file, third.ports, third.log), 'deployed');
    assert.deepEqual(host.builds, [`graphyard-local:${to.slice(0, 12)}`, `graphyard-local:${other.slice(0, 12)}`]);
    assert.deepEqual(host.lockedBuilds, [true, true], 'each build holds the image lock in the test\'s own lock directory');
  } finally {
    delete process.env.GRAPHYARD_VERSION; delete process.env.GRAPHYARD_BUILD_REVISION; delete process.env.MAINWORKS_LOCK_ROOT;
  }
});
