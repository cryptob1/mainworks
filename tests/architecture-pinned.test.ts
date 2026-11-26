import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionBoot } from '../src/remote-session.js';
import { findNetworkSpawns } from './architecture.test.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { git, gitRepo } from './helpers/git-repo.js';

// GY-3734: src/remote-session.ts unpacked local git bundles with `git('fetch', ...)` in both its
// container boot script and its host-side mirror, opening the git-network-door in
// tests/architecture.test.ts. Local bundles unpack with `git bundle unbundle` without invoking
// git fetch.

const repo = fileURLToPath(new URL('..', import.meta.url));

test('unit:architecture-pinned — src/remote-session.ts unpacks local bundles without git fetch, and round-trips work and answer bundles', async () => {
  const source = await readFile(join(repo, 'src/remote-session.ts'), 'utf8');
  assert.deepEqual(findNetworkSpawns(source), [], 'src/remote-session.ts must not spawn git fetch or any other git network subcommand');

  // Verify the local bundle unbundle path in both directions:
  // 1) worktree -> sessionBoot (answer.bundle applied via `git bundle unbundle` + `git merge --ff-only`)
  // 2) sessionBoot -> worktree (work.bundle unpacked via `git bundle unbundle` + reset/read-tree)
  const dir = await temporaryDirectory('architecture-pinned-bundle');
  const origin = join(dir, 'origin');
  const host = join(dir, 'host');
  const worktree = join(dir, 'worktree');
  const home = join(dir, 'home');
  const { head: base } = await gitRepo({ root: origin, files: { 'base.txt': 'base\n' } });

  git(dir, 'clone', '-q', origin, host);
  git(host, 'config', 'user.name', 'Test');
  git(host, 'config', 'user.email', 'test@example.com');
  git(origin, 'worktree', 'add', '-q', '-b', 'worker', worktree, base);

  // Create a commit on the worktree side to send as a relayed answer bundle (simulating `mainworks sync`).
  await writeFile(join(worktree, 'synced.txt'), 'from-worktree\n');
  git(worktree, 'add', 'synced.txt');
  git(worktree, 'commit', '-qm', 'synced commit');
  const syncedHead = git(worktree, 'rev-parse', 'HEAD');
  const answerBundlePath = join(dir, 'answer.bundle');
  git(worktree, 'bundle', 'create', answerBundlePath, 'HEAD', `^${base}`);
  const answerBundle = (await readFile(answerBundlePath)).toString('base64');

  // Run sessionBoot in `host` with a runtime that triggers one relayed call (receiving answerBundle),
  // then writes a new commit and an uncommitted file so sessionBoot emits a work bundle back.
  const sessionDir = join(dir, 'session');
  const runtime = join(dir, 'runtime.sh');
  await writeFile(runtime, `#!/bin/sh
set -e
printf '{"id":"call-1","argv":["sync"]}\\n' >> ${JSON.stringify(join(sessionDir, 'calls'))}
while [ ! -e ${JSON.stringify(join(sessionDir, 'answer-call-1.json'))} ]; do sleep 0.05; done
test -f synced.txt
echo "from-host" > host.txt
git add host.txt && git commit -qm "host commit"
echo "dirty" > uncommitted.txt
`, { mode: 0o755 });

  const workFrames: Array<{ head: string; work: string; bundle: string | null }> = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', sessionBoot.replace('/tmp/mainworks-session', sessionDir), runtime], {
      cwd: host,
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(`${JSON.stringify({ files: {}, back: [] })}\n`);
    let stderrBuf = '';
    child.stderr.on('data', chunk => {
      stderrBuf += String(chunk);
      for (let nl = stderrBuf.indexOf('\n'); nl !== -1; nl = stderrBuf.indexOf('\n')) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line.startsWith('\u001emainworks-')) continue;
        const space = line.indexOf(' '), kind = line.slice('\u001emainworks-'.length, space), body = line.slice(space + 1);
        if (kind === 'call') {
          const { id } = JSON.parse(body) as { id: string };
          child.stdin.write(`${JSON.stringify({ id, status: 0, stdout: '', stderr: '', commits: answerBundle })}\n`);
        } else if (kind === 'work') {
          workFrames.push(JSON.parse(body));
        }
      }
    });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`sessionBoot exited ${code}: ${stderrBuf}`)));
  });

  // 1) Host received the answer bundle and fast-forwarded past syncedHead, then committed on top.
  assert.equal(git(host, 'rev-parse', 'HEAD~1'), syncedHead, 'sessionBoot fast-forwarded its checkout from the answer bundle');

  // 2) Apply the final work frame to the worktree using `git bundle unbundle` (matching mirror()).
  const lastWork = workFrames.findLast(frame => frame.bundle !== null);
  assert.ok(lastWork && lastWork.bundle, 'sessionBoot emitted a work bundle');
  const workBundlePath = join(dir, 'work.bundle');
  await writeFile(workBundlePath, Buffer.from(lastWork.bundle, 'base64'));
  git(worktree, 'bundle', 'unbundle', workBundlePath);
  git(worktree, 'reset', '-q', '--hard', lastWork.head);
  if (lastWork.work !== lastWork.head) {
    git(worktree, 'read-tree', '-u', '--reset', lastWork.work);
    git(worktree, 'reset', '-q');
  }
  assert.equal(git(worktree, 'log', '-1', '--format=%s'), 'host commit', 'worktree received the host commit via git bundle unbundle');
  assert.equal((await readFile(join(worktree, 'uncommitted.txt'), 'utf8')).trim(), 'dirty', 'worktree received uncommitted work via git bundle unbundle');
});
