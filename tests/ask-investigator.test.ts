import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priorityServer } from './helpers/priority-server.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { workerPrompt } from '../src/master/dispatch.js';
import { masterPrompt } from '../src/master/harness.js';
import { guideText } from '../src/guide.js';

const cli = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const fields = { type: 'chore', priority: 3, why: 'w', simplest: 's', criteria: [{ id: 'AC-1', text: 'Asked', proofs: ['e2e:create-work-item'] }] };

// A stand-in runtime: records what it was given, tries to change its checkout, then answers as FAKE_MODE says.
const fakeRuntime = `#!/usr/bin/env node
const fs = require('node:fs');
let wrote = 'refused';
try { fs.writeFileSync('scribble.txt', 'x'); wrote = 'written'; } catch {}
try { fs.appendFileSync('README.md', 'changed'); wrote = 'written'; } catch {}
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8'), cwd: process.cwd(), readme: fs.readFileSync('README.md', 'utf8'), wrote, git: fs.existsSync('.git') }));
const mode = process.env.FAKE_MODE;
if (mode === 'hang') setTimeout(() => {}, 600000);
else if (mode === 'garbage') console.log('I looked around but have no JSON for you.');
else console.log('Here is what I found.\\n' + JSON.stringify({ summary: 'The readme names the branch head.', evidence: ['README.md:1'] }));
`;

test('integration:ask-investigator — one read-only headless session on the item head records its answer, or one failure line, on the item', async () => {
  const f = await priorityServer();
  try {
    const item = await f.ok('work', { ...fields, title: 'Investigate me' });
    await f.ok(`work/${item.id}/ready`, { reason: 'Ready' });
    const claimed = await f.ok(`work/${item.id}/claim`, {}, f.tokens.worker);
    const branch = `graphyard/${item.key.toLowerCase()}-${claimed.epoch}`;
    await f.ok(`work/${item.id}/workspace`, { epoch: claimed.epoch, host: 'test-host', path: '/tmp/ask-investigator-worktree', branch }, f.tokens.worker);

    // The caller's checkout: main says one thing, the item's branch head another.
    const repo = await temporaryDirectory('ask-investigator-repo');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'main head\n'); git('add', '.'); git('commit', '-qm', 'main');
    git('checkout', '-qb', branch); writeFileSync(join(repo, 'README.md'), 'item head\n'); git('commit', '-qam', 'item'); git('checkout', '-q', 'main');
    const before = { head: git('rev-parse', 'HEAD'), refs: git('for-each-ref'), status: git('status', '--porcelain') };

    const bin = await temporaryDirectory('ask-investigator-bin'), scratch = await temporaryDirectory('ask-investigator-tmp');
    writeFileSync(join(bin, 'claude'), fakeRuntime, { mode: 0o755 });
    const record = join(bin, 'record.json');
    // The built CLI's compile cache would otherwise land in scratch, which must hold only the investigator's checkouts.
    const ask = async (mode: string, extra: Record<string, string> = {}) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...extra, PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch, NODE_COMPILE_CACHE: join(bin, 'compile-cache'), FAKE_MODE: mode, FAKE_RECORD: record, GRAPHYARD_URL: f.url, GRAPHYARD_TOKEN: f.tokens.master };
      delete env.GRAPHYARD_TOKEN_FILE;
      return JSON.parse((await promisify(execFile)(process.execPath, [cli, 'ask', item.key, 'Where', 'is', 'the', 'head', 'named?'], { cwd: repo, env })).stdout);
    };
    const notes = async () => (await f.ok(`events?work=${item.id}&view=history&payload=details`)).events.filter((event: any) => event.kind.startsWith('investigator.'));

    // AC-1: the answer, a summary and file:line evidence, lands on the item's history; no lease is taken.
    await ask('answer');
    const seen = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(seen.readme, 'item head\n', 'the session reads a checkout of the item head, not the caller\'s HEAD');
    assert.ok(seen.stdin.includes('Where is the head named?'), 'the question is the session\'s own request, on stdin');
    assert.ok(seen.argv.includes('-p'), 'headless');
    const allowed = seen.argv[seen.argv.indexOf('--allowedTools') + 1], denied = seen.argv[seen.argv.indexOf('--disallowedTools') + 1];
    assert.equal(allowed, 'Read,Grep,Glob');
    for (const tool of ['Bash', 'Edit', 'Write']) assert.ok(denied.split(',').includes(tool), `${tool} is denied`);
    let [note] = await notes();
    assert.equal(note.kind, 'investigator.answered');
    assert.equal(note.actor, 'master');
    assert.deepEqual(note.details, { question: 'Where is the head named?', head: branch, summary: 'The readme names the branch head.', evidence: ['README.md:1'] });
    const after = await f.store.workDocument(item.id);
    assert.equal(after!.lease?.epoch, claimed.epoch, 'the worker keeps its lease');
    assert.equal(after!.lease?.owner, 'worker');

    // AC-2: the session cannot change its checkout or the repository, and the checkout is gone afterwards.
    assert.equal(seen.wrote, 'refused');
    assert.equal(seen.git, false, 'the checkout carries no link to the repository');
    assert.deepEqual({ head: git('rev-parse', 'HEAD'), refs: git('for-each-ref'), status: git('status', '--porcelain') }, before);
    assert.equal(existsSync(seen.cwd), false);
    assert.deepEqual(readdirSync(scratch), []);

    // AC-2: unparseable output and the time bound each record one plain failure line instead of an answer.
    await ask('garbage');
    [note] = await notes();
    assert.equal(note.kind, 'investigator.failed');
    assert.equal(note.details.summary, undefined);
    assert.match(note.details.failure, /^The investigator's answer could not be read: /);
    assert.doesNotMatch(note.details.failure, /\n/);
    await ask('hang', { GRAPHYARD_ASK_TIMEOUT_SECONDS: '2' });
    [note] = await notes();
    assert.equal(note.kind, 'investigator.failed');
    assert.equal(note.details.failure, 'The investigator ran past its 2-second bound and was stopped.');
    assert.deepEqual(readdirSync(scratch), []);

    // AC-3: one line each in the worker brief and the master prompt; the guide documents it.
    const brief = workerPrompt({ cliPath: '/cli.mjs' }, { key: 'GY-7', title: 'T' }, { principal: 'worker' }, 1);
    assert.equal(brief.split('/cli.mjs ask GY-7 QUESTION').length - 1, 1);
    const master = masterPrompt({ repository: 'owner/project', cliPath: '/cli.mjs' } as any);
    assert.equal(master.split('/cli.mjs ask GY-N QUESTION').length - 1, 1);
    assert.match(guideText('runtimes'), /`ask GY-N QUESTION` runs one read-only/);
  } finally { await f.close(); }
});
