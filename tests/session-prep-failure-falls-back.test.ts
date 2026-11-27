import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runRemoteSession, remoteSessionHost } from '../src/remote-session.js';
import { readHostReadings, sessionCooldown } from '../src/hosts.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { gitRepo } from './helpers/git-repo.js';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkersPage from '../web/pages/workers.js';
import { hostShimVerbs, hostShimDigest } from '../src/host-shim.js';
import { encodeLoopHosts, loopHosts } from '../src/model/loop-presence.js';

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { supervise } from '../src/session-watch.js';

const proof = 'integration:session-prep-failure-falls-back';
test(`${proof} — warm image failure starts the same attempt here and keeps the host out of session placement for 30 minutes`, async () => {
  const directory = await temporaryDirectory('session-prep-fallback');
  const { root } = await gitRepo({ root: join(directory, 'repo'), files: { 'base.txt': 'base' } });
  const target = 'gy-compute@broken', file = join(directory, 'hosts.json');
  await writeFile(file, JSON.stringify([{ target, sessions: 1, addedAt: new Date().toISOString() }]));
  const reason = 'warm image preparation failed: Docker CreateDiff mount callback failed';
  const run: ChildRun = async (command, args, options) => {
    if (command === 'docker') throw new Error(reason);
    if (command === 'ssh' && args.at(-1) === 'probe' || command === 'sh') return `shim ${hostShimDigest}\nuser 1001 gy-compute\ncores 8\nload 0\nverbs ${hostShimVerbs.join(' ')}\ncpu 100 0 100 800 0 0 0 0 0 0\nruns 0`;
    return defaultChildRun(command, args, options);
  };
  let output = '';
  const sink = { write(text: string) { output += text; return true; } } as NodeJS.WritableStream;
  const started = join(root, 'started.json');
  const before = Date.now();
  const code = await runRemoteSession({ target, worktree: root, homes: [], cli: join(directory, 'cli.mjs'),
    argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(started)}, JSON.stringify({epoch: 3, host: 'coordinator'}))`],
    env: {}, run, output: sink, errors: sink, hostsFile: file });
  assert.equal(code, 0, `preparation must not fail the supervised attempt: ${output}`);
  assert.deepEqual(JSON.parse(await readFile(started, 'utf8')), { epoch: 3, host: 'coordinator' });
  assert.equal(await remoteSessionHost('codex', () => [], run, file), null, 'a fresh placement skips the failed host');
  const reading = (await readHostReadings([], { file, run, local: 'here' })).find(host => host.host === target)!;
  const cooldown = reading.sessionCooldown;
  assert.ok(cooldown, 'status carries the session cooldown');
  assert.match(cooldown.reason, /Docker CreateDiff/);
  assert.ok(Date.parse(cooldown.until) >= before + 30 * 60_000);
  assert.ok(Date.parse(cooldown.until) <= Date.now() + 30 * 60_000);
  const sent = loopHosts(encodeLoopHosts([reading]))!;
  assert.deepEqual(sent[0]!.sessionCooldown, cooldown, 'the status transport keeps the reason and expiry');
  const page = renderToStaticMarkup(createElement(WorkersPage, { work: [], observedAt: Date.now(), setSelected: () => {}, setView: () => {}, token: 'fixture', status: { hosts: sent } } as never));
  assert.match(page, /data-session-cooldown="true">Sessions paused for 30 min: .*Docker CreateDiff/);
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse(cooldown.until) - 1;
    assert.equal(await remoteSessionHost('codex', () => [], run, file), null);
    Date.now = () => Date.parse(cooldown.until);
    assert.equal(await remoteSessionHost('codex', () => [], run, file), target, 'the host is eligible again at 30 minutes');
  } finally { Date.now = realNow; }

});

for (const failure of ['image load', 'helper', 'agent']) test(`${proof} — ${failure} failure ${failure === 'agent' ? 'ends the attempt without replay' : 'starts locally'}`, async () => {
  const directory = await temporaryDirectory('session-start-boundary');
  const { root } = await gitRepo({ root: join(directory, 'repo'), files: { 'base.txt': 'base' } });
  const file = join(directory, 'hosts.json'), bin = join(directory, 'bin'), target = 'gy-compute@boundary';
  await mkdir(bin);
  await writeFile(join(bin, 'ssh'), `#!/bin/sh
for arg; do case "$arg" in -fNM|-O) exit 0;; esac; done
IFS= read -r request
IFS= read -r handover
${failure === 'agent' ? "printf '\\036mainworks-started {}\\n' >&2" : ''}
echo 'helper Docker launch failed' >&2
exit 42
`);
  await chmod(join(bin, 'ssh'), 0o755);
  const run: ChildRun = async (command, args, options) => {
    if (command === 'docker') return args[0] === 'images' ? '' : `sha256:${'ab'.repeat(32)}`;
    if (command === 'ssh' && args.at(-1)?.startsWith('prepare-run')) {
      if (failure === 'image load') throw new Error('image load failed');
      return 'run trial-boundary';
    }
    if (command === 'ssh') return '';
    return defaultChildRun(command, args, options);
  };
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  let local = false;
  let printed = '';
  const sink = { write(text: string) { printed += text; return true; } } as NodeJS.WritableStream;
  try {
    const code = await runRemoteSession({ target, worktree: root, homes: [], cli: join(directory, 'cli'), argv: [process.execPath, '-e', 'process.exit(0)'],
      env: {}, run, hostsFile: file, onLocal: () => { local = true; }, output: sink, errors: sink });
    assert.equal(code, failure === 'agent' ? 42 : 0, printed);
    assert.equal(local, failure !== 'agent');
    assert.equal(Boolean(await sessionCooldown(target, file)), failure !== 'agent');
  } finally { process.env.PATH = previous; }
});

test(`${proof} — the supervisor keeps the claimed epoch and records no failed attempt while the fallback agent runs`, { timeout: 30_000 }, async () => {
  const store = await withDatabase('session-prep-fallback');
  await store.init();
  const directory = await temporaryDirectory('session-prep-supervisor');
  const { root } = await gitRepo({ root: join(directory, 'repo'), files: { 'base.txt': 'base' } });
  const engine = new Engine(store, 120, 'owner/project');
  const operator = { id: 'operator', role: 'admin', sessionKind: 'human' } as const;
  const worker = { id: 'builder', role: 'worker', sessionKind: 'ai' } as const;
  let supervising: Promise<number> | undefined;
  let item;
  const surrendered: string[] = [];
  try {
    item = await engine.execute(operator, 'create', null, { title: 'Builder preparation fallback', type: 'chore', criteria: [{ id: 'AC-1', text: 'Starts elsewhere', proofs: [proof, 'e2e:verification-uses-remote-hosts'] }] }, randomUUID());
    item = await engine.execute(operator, 'ready', item.id, {}, randomUUID());
    item = await engine.execute(worker, 'claim', item.id, {}, randomUUID());
    const work = item.id, epoch = item.lease!.epoch;
    const started = join(directory, 'agent-started'), script = join(directory, 'session.mjs');
    const source = fileURLToPath(new URL('../src/remote-session.ts', import.meta.url));
    const runner = fileURLToPath(new URL('../src/child-runner.ts', import.meta.url));
    const input = { target: 'gy-compute@broken', worktree: root, homes: [], cli: join(directory, 'cli'), hostsFile: join(directory, 'hosts.json'), env: {},
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(started)}, '${epoch}'); setInterval(() => {}, 1000)`] };
    await writeFile(script, `import { runRemoteSession } from ${JSON.stringify(source)};
import { defaultChildRun } from ${JSON.stringify(runner)};
process.exitCode = await runRemoteSession({ ...${JSON.stringify(input)}, run: async (command, args, options) => {
  if (command === 'docker') throw new Error('warm image preparation failed: Docker CreateDiff mount callback failed');
  return defaultChildRun(command, args, options);
} });
`);
    supervising = supervise(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), script], epoch,
      async () => { const renewed = await engine.execute(worker, 'heartbeat', work, { epoch }, randomUUID()); return { lease: renewed.lease, updatedAt: renewed.updatedAt }; },
      { intervalMs: 100, graceMs: 50, log: join(directory, 'run.jsonl'), session: { surrender: async cause => {
        surrendered.push(cause);
        await engine.execute(worker, 'release', work, { epoch, cause }, randomUUID());
      } } });
    let ended = false;
    void supervising.then(() => { ended = true; });
    for (let tries = 0; tries < 200 && !existsSync(started) && !ended; tries++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(existsSync(started), true, 'the fallback agent starts before the supervisor ends its attempt');
    assert.equal(await readFile(started, 'utf8'), String(epoch));
    const current = (await store.list()).find(entry => entry.id === work)!;
    assert.equal(current.lease?.epoch, epoch);
    assert.equal(current.pipeline!.attempts.length, 1, 'no new attempt was claimed');
    assert.equal(current.pipeline!.attempts.filter(attempt => attempt.endedAt).length, 0, 'no attempt failed');
    assert.deepEqual(surrendered, [], 'preparation did not make the supervisor release the claim');
  } finally {
    if (item?.lease) await engine.execute(worker, 'release', item.id, { epoch: item.lease.epoch }, randomUUID()).catch(() => {});
    await supervising;
    await store.close();
  }
});
