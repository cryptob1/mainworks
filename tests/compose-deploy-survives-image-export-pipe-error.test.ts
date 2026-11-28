import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
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

for (const target of ['trial', 'server'] as const) for (const [name, failures, expected, attempts] of [
  ['clean build', [], 'deployed', 1],
  ['one closed pipe', [pipe], 'deployed', 2],
  ['persistent closed pipe', [pipe, pipe], 'rolled-back', 2],
  ['other Docker error', ['ERROR: failed to solve: no space left on device'], 'rolled-back', 1],
] as const) test(`e2e:compose-deploy-survives-image-export-pipe-error — ${target}: ${name}`, async () => {
  const root = await temporaryDirectory('compose-export');
  let builds = 0, loads = 0, serving = previous;
  const transport = fakeTransport({ responses: [
    { match: 'mktemp', result: `${root}/image-export\n` },
    { match: target === 'trial' ? 'docker buildx build' : 'docker build ', result: () => {
      const error = failures[builds++];
      return { code: error ? 1 : 0, stdout: '', stderr: error ?? '' };
    } },
    { match: 'docker load', result: () => { loads++; return ''; } },
  ] });
  await withEnv({ MAINWORKS_LOCK_ROOT: root, [slotsDirectoryVariable]: join(root, 'slots') }, async () => {
    const ports = deployPorts(next, previous, {
      restart: async commit => {
        if (commit === next) await composeAdapter.provision({ sourceRoot: root, transport, image: 'mainworks-local:proof' } as unknown as AdapterContext, {} as never);
        serving = commit;
      },
      health: async commit => { assert.equal(serving, commit); },
    });
    assert.equal(await deployOnce(deployRecordPath(root), ports, () => {}), expected);
  });
  assert.equal(builds, attempts, 'at most one retry of the exact pipe error');
  assert.equal(serving, expected === 'deployed' ? next : previous);
  assert.equal(loads, target === 'server' || expected === 'deployed' ? 1 : 0, 'only a completed archive is loaded');
  const calls = transport.commands.map((_, index) => transport.line(index));
  assert.ok(calls.some(line => line.includes('--output type=docker,dest=') && !line.includes('--load')), 'export a Docker archive without a live importer pipe');
  assert.ok(calls.some(line => line.startsWith('rm -rf ') && line.includes('/image-export')), 'remove the archive after success or failure');
  if (expected === 'rolled-back') assert.ok(readDeployRecord(deployRecordPath(root))?.reason?.includes(failures[0]!), 'keep Docker’s own error sentence');
});

test('e2e:compose-deploy-survives-image-export-pipe-error — importer errors preserve Docker diagnostics and retry only the closed pipe', async () => {
  const root = await temporaryDirectory('compose-import');
  for (const diagnostic of [pipe, 'Error response from daemon: failed to ingest layer: no space left on device']) {
    let loads = 0;
    const transport = fakeTransport({ responses: [
      { match: 'mktemp', result: `${root}/image-export\n` },
      { match: 'docker load', result: () => ({ stdout: '', stderr: loads++ === 0 ? diagnostic : '', code: loads === 1 ? 1 : 0 }) },
    ] });
    const provision = provisionTrialImage({ sourceRoot: root, transport }, null);
    if (diagnostic === pipe) { await provision; assert.equal(loads, 2); }
    else { await assert.rejects(provision, error => error instanceof Error && error.message.includes(diagnostic)); assert.equal(loads, 1); }
  }
});

// Docker is deliberately a process stand-in: private-root trials have no host Docker
// socket. Exercise the real command transport and archive bytes without host authority.
test('e2e:compose-deploy-survives-image-export-pipe-error — process transport exports and loads a new revision', async () => {
  const root = await temporaryDirectory('compose-export-process'), real = localTransport();
  const state = join(root, 'loaded.json'), calls = join(root, 'calls.jsonl');
  await writeFile(join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'buildx' && args[1] === 'inspect') process.exit(0);
if (args[0] === 'buildx' && args[1] === 'build') {
  const output = args[args.indexOf('--output') + 1];
  if (!output.startsWith('type=docker,dest=') || args.includes('--load')) throw Error('expected separate Docker archive export');
  fs.writeFileSync(output.slice('type=docker,dest='.length), JSON.stringify({ tag: args[args.indexOf('--tag') + 1], revision: fs.readFileSync(args.at(-1) + '/revision', 'utf8') }));
} else if (args[0] === 'load' && args[1] === '--input') {
  const image = JSON.parse(fs.readFileSync(args[2], 'utf8'));
  if (image.tag !== 'mainworks-trial:local') throw Error('archive lost its tag');
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(image));
} else throw Error('unexpected Docker command: ' + args.join(' '));
`, { mode: 0o755 });
  const transport = { ...real, exec: (program: string, args: string[], options?: Parameters<typeof real.exec>[2]) =>
    real.exec(program === 'docker' ? join(root, 'docker') : program, args, options) };
  for (const revision of [previous, next]) {
    await writeFile(join(root, 'revision'), revision);
    await provisionTrialImage({ sourceRoot: root, transport }, null);
    assert.equal(JSON.parse(await readFile(state, 'utf8')).revision, revision, 'load replaces the image with the new revision');
  }
  const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.deepEqual(commands.map(args => args.slice(0, 2)), [
    ['buildx', 'inspect'], ['buildx', 'build'], ['load', '--input'],
    ['buildx', 'inspect'], ['buildx', 'build'], ['load', '--input'],
  ]);
  for (const args of commands.filter(args => args[0] === 'load')) await assert.rejects(readFile(args[2]!), { code: 'ENOENT' }, 'export archives are removed after loading');
});
