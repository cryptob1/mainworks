import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { composeAdapter, type AdapterContext } from '../src/install/adapters.js';
import type { Transport } from '../src/install/transport.js';
import { deployOnce, type DeployWatchPorts } from '../src/deploy-watch.js';
import { pruneImages } from '../src/cli/upgrade.js';

// GY-3718: an install whose release image already exists provisions without building, and old-image
// removal by any install on the host waits for the image lock another install's provisioning holds.

/** One Docker host: a build takes a while and fails as BuildKit does when an image is removed during it. */
function dockerHost(tags: string[]) {
  const images = new Set(tags), builds: string[] = [], events: string[] = [];
  let building = 0, removedDuringBuild = false;
  const build = async (tag: string) => {
    building++; builds.push(tag); events.push(`build ${tag}`);
    await delay(300);
    building--;
    if (removedDuringBuild) { removedDuringBuild = false; throw new Error(`docker build ${tag}: failed to solve: lease does not exist: not found`); }
    images.add(tag); events.push(`built ${tag}`);
  };
  const transport: Transport = {
    description: 'one docker host',
    async exec(program, args) {
      if (program === 'docker' && args[0] === 'build') await build(args[args.indexOf('--tag') + 1]!);
      if (program === 'docker' && args[0] === 'buildx' && args[1] === 'build') await build(args[args.indexOf('--tag') + 1]!);
      if (program === 'docker' && args[0] === 'image' && args[1] === 'inspect') return { stdout: '', stderr: '', code: images.has(args[2]!) ? 0 : 1 };
      return { stdout: '', stderr: '', code: 0 };
    },
    async putFile() {},
  };
  const run = async (program: string, args: string[]) => {
    if (program === 'docker' && args[0] === 'image' && args[1] === 'ls') return [...images].filter(tag => tag.startsWith('mainworks-local:')).map(tag => tag.split(':')[1]).join('\n');
    if (program === 'docker' && args[0] === 'image' && args[1] === 'rm') { if (building) removedDuringBuild = true; images.delete(args[2]!); events.push(`rm ${args[2]}`); }
    return '';
  };
  return { transport, run, images, builds, events };
}

/** An install on that host: a restart that provisions the commit's image and serves it, and a prune of old images. */
async function install(host: ReturnType<typeof dockerHost>, name: string, from: string, to: string) {
  const directory = await temporaryDirectory(`image-lock-${name}`), state = { serving: from }, log: string[] = [];
  const ports: DeployWatchPorts = {
    fetch: async () => to, head: async () => from,
    build: async () => {},
    restart: async commit => {
      const image = `mainworks-local:${commit.slice(0, 12)}`;
      await composeAdapter.provision({ sourceRoot: directory, image, transport: host.transport } as unknown as AdapterContext, {} as never);
      if (!host.images.has(image)) throw new Error(`${image} is missing`);
      state.serving = commit;
    },
    health: async commit => { if (state.serving !== commit) throw new Error(`/healthz answers ${state.serving.slice(0, 7)}`); },
    checkout: async () => {}, pin: async () => {},
    prune: keep => pruneImages(host.run, keep, line => log.push(line)),
    schema: async () => 1, database: async () => 1,
  };
  return { file: join(directory, '.graphyard', 'deploy.json'), ports, state, log, deploy: () => deployOnce(join(directory, '.graphyard', 'deploy.json'), ports, line => log.push(line)) };
}

const local = (sha: string) => `mainworks-local:${sha.slice(0, 12)}`;

test('integration:image-lock-covers-provision — a deploy whose image exists provisions without building while another install removes old images; a deploy that builds holds the image lock against old-image removal', async () => {
  const old = randomBytes(20).toString('hex'), from = randomBytes(20).toString('hex'), to = randomBytes(20).toString('hex'), other = randomBytes(20).toString('hex');
  process.env.GRAPHYARD_VERSION = '2026.11.23'; process.env.GRAPHYARD_BUILD_REVISION = to;
  try {
    const host = dockerHost([local(old), local(from)]);

    // Huck's watch deploys the verified commit first: one build of its image.
    const huck = await install(host, 'huck', from, to);
    assert.equal(await huck.deploy(), 'deployed', huck.log.join('\n'));
    const built = [...host.builds];
    assert.ok(built.includes(local(to)), 'huck built the commit image');

    // Ours deploys the same commit while Huck's watch removes old images: no build, no rollback.
    const mainworks = await install(host, 'mainworks', from, to);
    const deploying = mainworks.deploy();
    await delay(50);
    await pruneImages(host.run, [to], () => {});
    assert.equal(await deploying, 'deployed', mainworks.log.join('\n'));
    assert.deepEqual(host.builds, built, 'provisioning an existing image builds nothing');
    assert.equal(mainworks.state.serving, to);
    assert.equal(huck.state.serving, to);

    // A commit without an image is built once, and old-image removal waits for that build.
    host.images.add(local(old));
    process.env.GRAPHYARD_BUILD_REVISION = other;
    const third = await install(host, 'third', to, other);
    const building = third.deploy();
    await delay(50);
    await pruneImages(host.run, [to, other], () => {});
    assert.equal(await building, 'deployed', third.log.join('\n'));
    assert.equal(host.builds.filter(tag => tag === local(other)).length, 1, 'one build of the new commit image');
    const events = host.events.slice(host.events.indexOf(`build ${local(other)}`));
    assert.ok(events.indexOf(`rm ${local(old)}`) > events.indexOf(`built ${local(other)}`), `old-image removal waits for the build: ${events.join(', ')}`);
  } finally {
    delete process.env.GRAPHYARD_VERSION; delete process.env.GRAPHYARD_BUILD_REVISION;
  }
});
