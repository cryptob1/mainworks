import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildRun } from '../src/child-runner.js';
import { remoteShardSession, warmCommitOnHosts, warmImageTag, type ShardSshSession } from '../src/merge-writer/remote-shards.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3936 AC-1: a new warm image whose test database fails `postgres --version` is never tagged
// and never sent; the next trial runs on the previous good image.

const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const cleanup of cleanups) await cleanup().catch(() => {}); });

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

test('unit:failed-warm-image-self-check-keeps-previous-image — a warm image failing its database check is discarded untagged and unsent; the trial uses the previous image', async () => {
  const root = await temporaryDirectory('warm-self-check');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(join(root, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3,"packages":{}}\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'previous');
  const previous = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'README'), 'next\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'next');
  const next = git(root, 'rev-parse', 'HEAD');

  const image = 'mainworks-trial:self-check', digest = `sha256:${'3936'.repeat(16)}`;
  const lockHash = (await import('node:crypto')).createHash('sha256').update(git(root, 'show', `${previous}:package-lock.json`)).digest('hex');
  const previousTag = warmImageTag(digest, lockHash, previous), nextTag = warmImageTag(digest, lockHash, next);
  const images = new Set([image, previousTag]), tagged: string[] = [], sent: string[] = [], prepared: string[] = [];
  const run: ChildRun = async (command, args) => {
    if (command === 'git') return execFileSync('git', args, { encoding: 'utf8' });
    if (command === 'docker') {
      if (args[0] === 'image' && args[1] === 'inspect') { if (!images.has(args.at(-1)!)) throw new Error('No such image'); return args.at(-1) === image ? digest : `sha256:${'1'.repeat(64)}`; }
      if (args[0] === 'images') return [...images].filter(name => name.startsWith('graphyard-warm:')).join('\n');
      if (args[0] === 'commit') { images.add(args.at(-1)!); return ''; }
      if (args[0] === 'tag') { tagged.push(args[2]!); images.add(args[2]!); return ''; }
      if (args[0] === 'image' && args[1] === 'rm') { images.delete(args[2]!); return ''; }
      if (args[0] === 'run' && args.at(-1)!.includes('--version')) throw Object.assign(new Error('exit 127'), { stderr: 'postgres: error while loading shared libraries: libicui18n.so.60: cannot open shared object file' });
      return '';
    }
    if (command === 'sh') { if (args[1]!.includes('receive-image')) sent.push(args[1]!); return ''; }
    if (command === 'ssh') { const verb = args.at(-1)!; if (verb.startsWith('prepare-run ')) { prepared.push(verb.split(' ')[3]!); return 'run /tmp/run-1'; } return ''; }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };

  const warmed = warmCommitOnHosts({ root, commit: next, image, hosts: ['box'], run, deadline: Date.now() + 60_000,
    read: async () => [{ name: 'local', cores: 4, busy: 0, steal: 0, celsius: null, limit: 85, away: false }, { name: 'box', cores: 4, busy: 0, steal: 0, celsius: null, limit: 85, away: false }] });
  await assert.rejects(warmed, /failed `postgres --version`.*libicui18n/s, 'the failure names the failing command');
  assert.ok(!images.has(nextTag), 'the failing image is never tagged as the warm image');
  assert.ok(!tagged.includes(nextTag), 'no docker tag was made for it');
  assert.deepEqual([...images].filter(name => name.startsWith('graphyard-warm-check:')), [], 'the failing candidate is removed');
  assert.deepEqual(sent, [], 'nothing is sent to a host');

  const transport = { session: async <T>(target: string, use: (words: string[]) => T | Promise<T>) => use([target]), close: async () => {} } as unknown as ShardSshSession;
  const session = remoteShardSession({ root, sha: next, baseTip: next, image, run, deadline: Date.now() + 60_000, transport });
  assert.equal(await session.ready('box'), '/tmp/run-1');
  assert.deepEqual(prepared, [previousTag], 'the trial runs on the previous good image');
  await session.close();
});
