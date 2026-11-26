// GY-3904 (re-land GY-3902): a watch killed between health and checkout leaves the server on the new tip with the CLI and
// loop pin behind; the restarted watch finds the tip already serving and moves both before recording it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { deployOnce, deployRecordPath, readDeployRecord, type DeployWatchPorts } from '../src/deploy-watch.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40);

test('unit:already-serving-still-pins-cli-and-loop — a watch killed between health and checkout, restarted, leaves the CLI release and loop pin on the served commit', async () => {
  const root = await temporaryDirectory('already-serving-pins'), file = deployRecordPath(root);
  let serving = a, cli = a, pin = a;
  const calls: string[] = [];
  let killed = false;
  const ports: DeployWatchPorts = {
    fetch: async () => b, head: async () => a,
    build: async () => {}, restart: async commit => { serving = commit; }, health: async commit => { if (serving !== commit) throw new Error('unhealthy'); },
    serves: async commit => serving === commit,
    checkout: commit => { if (!killed) { killed = true; return new Promise<void>(() => {}); } calls.push('checkout'); cli = commit; return Promise.resolve(); },
    pin: async commit => { calls.push('pin'); pin = commit; },
    prune: async () => {}, schema: async () => 1, database: async () => 1,
  };
  // The first watch dies at checkout: the server already serves b, the CLI and pin are on a.
  void deployOnce(file, ports, () => {}, null);
  for (const start = Date.now(); !killed; await new Promise(done => setTimeout(done, 5))) if (Date.now() - start > 5_000) assert.fail('never reached checkout');
  await rm(join(dirname(file), 'deploy.lock'), { force: true }); // the killed process's lock
  assert.deepEqual([serving, cli, pin], [b, a, a]);

  assert.equal(await deployOnce(file, ports, () => {}, null), 'unchanged');
  assert.deepEqual([cli, pin, readDeployRecord(file)?.tip], [b, b, b], 'the CLI release and loop pin equal the served commit');
  assert.deepEqual(calls, ['checkout', 'pin']);

  // Already on the tip: a later pass changes nothing.
  assert.equal(await deployOnce(file, ports, () => {}, null), 'unchanged');
  assert.deepEqual([cli, pin, calls.length], [b, b, 2]);
});
