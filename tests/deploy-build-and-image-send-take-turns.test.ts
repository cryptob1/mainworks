// GY-4053: a warm image sent to a test machine (`docker save | ssh … receive-image`) and a deploy build
// on the same Docker take turns under GY-4030's real image lock, so neither loses its BuildKit lease.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildRun } from '../src/child-runner.js';
import { controlPlaneRecordPath, deployOnce, deployRecordPath, readControlPlaneRecord } from '../src/deploy-watch.js';
import { remoteShardSession, type ShardSshSession } from '../src/merge-writer/remote-shards.js';
import { deployPorts } from './helpers/deploy-ports.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40), sha = 'c'.repeat(40);

/** A fake Docker whose export and save fail the way BuildKit does when the two overlap. */
function fakeDocker(ms: number) {
  let busy = 0;
  const spans: { what: string; start: number; end: number }[] = [];
  const use = async (what: string) => {
    const start = Date.now();
    busy++;
    try {
      await delay(ms);
      if (busy > 1) throw new Error('failed to copy to tar: commit failed: lease does not exist: not found');
    } finally { busy--; }
    spans.push({ what, start, end: Date.now() });
  };
  return { use, spans };
}

test('integration:deploy-build-and-image-send-take-turns — a deploy build and a warm image save started one second apart both succeed in turn, each status naming what it waits for', { timeout: 60_000 }, async () => {
  process.env.MAINWORKS_LOCK_ROOT = await temporaryDirectory('send-turns-locks');
  try {
    const docker = fakeDocker(2500), root = await temporaryDirectory('send-turns-deploy');
    let running = a;
    const deploy = deployOnce(deployRecordPath(root), deployPorts(b, a, {
      restart: async commit => { await docker.use('build'); running = commit; },
      health: async commit => { if (running !== commit) throw new Error(`serves ${running.slice(0, 12)}`); },
      lockFile: `${root}/deploy.lock`, install: 'core',
    }), () => {}, null);
    await delay(1000);
    let sent = false;
    const run: ChildRun = async (command, args) => {
      const line = args.join(' ');
      if (command === 'sh' && line.includes('docker save')) { await docker.use('save'); sent = true; return ''; }
      if (command === 'ssh' && line.includes('prepare-run')) return sent ? 'run /runs/1' : 'need-image';
      throw new Error(`unexpected ${command} ${line}`);
    };
    const transport = { session: async (_target: string, use: (words: string[]) => unknown) => use(['vish-msi']), close: async () => {} } as unknown as ShardSshSession;
    const waits: string[] = [];
    const session = remoteShardSession({ root, sha, image: 'trial', run, deadline: Date.now() + 60_000, transport, warm: async () => 'graphyard-warm:x', onWait: reason => { waits.push(String(reason)); } });
    const send = session.ready('vish-msi');
    assert.deepEqual(await Promise.all([deploy, send]), ['deployed', '/runs/1'], 'both the deploy and the send succeed');
    assert.deepEqual(docker.spans.map(span => span.what), ['build', 'save'], 'the deploy builds first, then the image is sent');
    assert.ok(docker.spans[1]!.start >= docker.spans[0]!.end, 'the build and the save never overlap');
    assert.deepEqual(waits, ["Sending the warm image to vish-msi waits for core's image build to finish", 'null'], 'the trial says what it waits for, then resumes its step');

    // The other order: a save is running, and a deploy build waits for it, saying so in its status.
    const second = await temporaryDirectory('send-turns-deploy-2');
    let deployWait: string | undefined;
    sent = false;
    const again = remoteShardSession({ root, sha, image: 'trial', run, deadline: Date.now() + 60_000, transport, warm: async () => 'graphyard-warm:x' });
    const sending = again.ready('vish-msi');
    await delay(1000);
    let serving = a;
    const later = deployOnce(deployRecordPath(second), deployPorts(b, a, {
      restart: async commit => { await docker.use('build'); serving = commit; },
      health: async commit => { if (serving !== commit) throw new Error(`serves ${serving.slice(0, 12)}`); },
      lockFile: `${second}/deploy.lock`, install: 'core',
    }), () => {}, null);
    for (let at = Date.now(); Date.now() - at < 2000 && !deployWait; await delay(50)) deployWait = readControlPlaneRecord(controlPlaneRecordPath(second))?.waiting?.reason;
    assert.deepEqual(await Promise.all([sending, later]), ['/runs/1', 'deployed'], 'both succeed in turn');
    assert.equal(deployWait, 'Waits for a warm image send to vish-msi to finish', 'the deploy says what it waits for');
    assert.deepEqual(docker.spans.slice(2).map(span => span.what), ['save', 'build']);
    assert.ok(docker.spans[3]!.start >= docker.spans[2]!.end, 'the save and the build never overlap');
  } finally { delete process.env.MAINWORKS_LOCK_ROOT; }
});
