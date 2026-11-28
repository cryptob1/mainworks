import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildRun } from '../src/child-runner.js';
import { ensureWarmImage } from '../src/merge-writer/remote-shards.js';
import { composeAdapter, type AdapterContext } from '../src/install/adapters.js';
import type { Transport } from '../src/install/transport.js';
import { controlPlaneRecordPath, deployOnce, readControlPlaneRecord, readDeployRecord } from '../src/deploy-watch.js';
import { deployPorts } from './helpers/deploy-ports.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// One stand-in Docker shared by the loop and two installs: an overlapping export is recorded,
// and only a finished build makes its tag inspectable. No real Docker or host lock is touched.
test('integration:warm-commit-takes-image-lock — warm build and commit exclude deploy builds; a second install waits and reuses the first install’s tag', { timeout: 30_000 }, async () => {
  const locks = process.env.MAINWORKS_LOCK_ROOT = await temporaryDirectory('warm-commit-locks');
  const from = 'a'.repeat(40), commit = 'b'.repeat(40), image = 'mainworks-trial:fixture';
  process.env.GRAPHYARD_VERSION = '2026.11.28';
  process.env.GRAPHYARD_BUILD_REVISION = commit;
  const images = new Set([image]), events: string[] = [], overlaps: string[] = [], unlocked: string[] = [];
  let writing = '';
  let committed!: () => void, built!: () => void;
  const committing = new Promise<void>(resolve => { committed = resolve; });
  const building = new Promise<void>(resolve => { built = resolve; });
  const write = async (kind: string) => {
    if (writing) overlaps.push(`${kind} beside ${writing}`);
    if (!existsSync(join(locks, 'graphyard-local-images.lock'))) unlocked.push(kind);
    writing = kind; events.push(`${kind}:start`);
    if (kind === 'warm commit') committed();
    if (kind === 'deploy build') built();
    await delay(250);
    events.push(`${kind}:end`); writing = '';
  };
  const run: ChildRun = async (command, args) => {
    if (command === 'git') return '{}';
    if (command === 'sh') { await write('warm build'); return ''; }
    if (command === 'docker') {
      if (args[0] === 'image' && args[1] === 'inspect') {
        if (!images.has(args.at(-1)!)) throw new Error('No such image');
        return `sha256:${'c'.repeat(64)}`;
      }
      if (args[0] === 'commit') { await write('warm commit'); images.add(args.at(-1)!); }
      if (args[0] === 'tag') images.add(args[2]!);
      if (args[0] === 'images') return [...images].filter(tag => tag.startsWith('graphyard-warm:')).join('\n');
      return '';
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  const transport: Transport = {
    description: 'shared stand-in docker',
    async exec(command, args) {
      if (command === 'docker' && args[0] === 'image' && args[1] === 'inspect') return { stdout: '', stderr: '', code: images.has(args[2]!) ? 0 : 1 };
      if (command === 'docker' && args[0] === 'build') {
        await write('deploy build'); images.add(args[args.indexOf('--tag') + 1]!);
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    async putFile() {},
  };
  const install = async (name: string) => {
    const root = await temporaryDirectory(`warm-commit-${name}`), file = join(root, '.graphyard', 'deploy.json');
    const actions: string[] = [];
    let serving = from;
    const ports = deployPorts(commit, from, {
      install: name, lockFile: join(root, 'deploy.lock'),
      restart: async head => {
        await composeAdapter.provision({ sourceRoot: root, image: `mainworks-local:${head.slice(0, 12)}`, transport } as AdapterContext, {} as never);
        serving = head; actions.push(`${name}:restart`);
      },
      pin: async () => { actions.push(`${name}:pin`); },
      health: async head => { assert.equal(serving, head); },
    });
    return { file, controlFile: controlPlaneRecordPath(root), ports, actions, serving: () => serving };
  };
  try {
    const core = await install('core'), huck = await install('huck');
    const warm = ensureWarmImage({ root: '/fixture', commit, image, run, deadline: Date.now() + 25_000 });
    await committing;
    const first = deployOnce(core.file, core.ports, () => {}, null);
    await building;
    const second = deployOnce(huck.file, huck.ports, () => {}, null);
    const results = await Promise.all([warm, first, second]);
    assert.deepEqual(overlaps, [], 'warm commit and deploy export must never overlap');
    assert.deepEqual(unlocked, [], 'warm build and commit must hold the same host lock as deploy');
    assert.ok(events.indexOf('deploy build:start') > events.indexOf('warm commit:end'));
    assert.equal(events.filter(event => event === 'deploy build:start').length, 1, 'second install waits and reuses the completed tag');
    assert.deepEqual(results.slice(1), ['deployed', 'deployed']);
    for (const [name, one] of [['core', core], ['huck', huck]] as const) {
      assert.equal(one.serving(), commit);
      assert.equal(readDeployRecord(one.file)?.tip, commit);
      assert.equal(readControlPlaneRecord(one.controlFile)?.commit, commit, 'each install keeps its control-plane record inside its own root');
      assert.deepEqual(one.actions, [`${name}:restart`, `${name}:pin`], 'each install changes only its own service and release');
    }
  } finally {
    delete process.env.MAINWORKS_LOCK_ROOT;
    delete process.env.GRAPHYARD_VERSION;
    delete process.env.GRAPHYARD_BUILD_REVISION;
  }
});
