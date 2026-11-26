import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedPackage } from '../src/publish-verified.js';

// GY-3873: the README sells Mainworks — the promise, the walkthrough above the fold, the sections in the
// owner's order, the search terms early, true badges only — and every command and path in it resolves.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean));
const searchTerms = ['AI coding agents', 'open source', 'Claude Code', 'Codex', 'Gemini', 'self-hosted', 'code review', 'merge queue', 'autonomous'];

test('unit:readme-commands-and-links-resolve — the README opens with the promise and walkthrough, keeps the owner\'s order, names the search terms early, carries true badges, and every fenced command and file link resolves', () => {
  const readme = read('README.md');
  const manifest = JSON.parse(read('package.json'));
  const lines = readme.split('\n');
  assert.equal(lines[0], '# Mainworks');
  const promise = lines[2]!.replace(/\*\*/g, '');
  for (const phrase of ['AI coding agents', 'open source']) assert.ok(promise.toLowerCase().includes(phrase.toLowerCase()), `the promise says ${phrase}`);
  assert.equal(promise.match(/[.!?](\s|$)/g)?.length, 1, 'the promise is one sentence');
  assert.equal(manifest.description, promise, 'package.json description is the promise');
  for (const term of searchTerms) assert.ok(manifest.keywords.includes(term.toLowerCase()), `package.json keywords include ${term}`);

  const fold = readme.split('\n## ')[0]!;
  assert.match(fold, /\]\(docs\/diagrams\/how-mainworks-works\.gif\)/, 'the walkthrough is above the first section');
  assert.deepEqual([...readme.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['What Mainworks does', 'Quick start', 'How it works', 'What you need', 'Where to go next']);
  const section = (name: string) => readme.split(`\n## ${name}\n`)[1]!.split('\n## ')[0]!.trim();
  const bullets = section('What Mainworks does').split('\n');
  assert.ok(bullets.length <= 6 && bullets.every(line => line.startsWith('- ')), 'what it does is at most six one-line bullets');
  const steps = section('How it works').split('\n').filter(line => /^\d+\. /.test(line)).map(line => line.toLowerCase());
  ['goal', 'build', 'independent review', 'merge trial', 'deploy', 'automatic revert'].forEach((step, index) => assert.ok(steps[index]?.includes(step), `step ${index + 1} is ${step}`));

  const early = `${readme.split(/\s+/).slice(0, 200).join(' ')}\n${lines.filter(line => line.startsWith('#')).join('\n')}`.toLowerCase();
  for (const term of searchTerms) assert.ok(early.includes(term.toLowerCase()), `${term} is in a heading or the first 200 words`);

  const badges = [...readme.matchAll(/img\.shields\.io\/badge\/([^)\s]+)/g)].map(match => decodeURIComponent(match[1]!));
  assert.deepEqual(badges.map(badge => badge.split('-')[0]), ['license', 'node'], 'badges are the license and Node version only');
  assert.ok(badges[0]!.includes(manifest.license.replace('-', ' ')), `the license badge says ${manifest.license}`);
  assert.ok(badges[1]!.includes(manifest.engines.node), `the Node badge says ${manifest.engines.node}`);
  assert.doesNotMatch(readme, /GY-\d+/, 'no internal ids');

  // Every relative file link names a tracked file.
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!).filter(target => !/^[a-z]+:/i.test(target));
  assert.ok(links.length >= 6, `links checked: ${links.length}`);
  for (const link of links) assert.ok(tracked.has(link), `README links ${link}, which is a tracked file`);

  // Every fenced command resolves: the clone URL is this repository, npm scripts exist, node runs a tracked file, npx the published package.
  const commands = [...readme.matchAll(/```sh\n([^`]+)```/g)].flatMap(match => match[1]!.trim().split('\n')).flatMap(line => line.split(' && '));
  assert.ok(commands.length >= 5, `commands checked: ${commands.length}`);
  for (const command of commands) {
    const [program, first, second] = command.trim().split(/\s+/);
    if (program === 'git' && first === 'clone') assert.equal(second, 'https://github.com/cryptob1/mainworks.git', command);
    else if (program === 'cd') assert.equal(first, manifest.name, command);
    else if (program === 'npm' && first === 'run') assert.ok(manifest.scripts[second!], `${command}: npm script ${second} exists`);
    else if (program === 'npm') assert.equal(first, 'ci', command);
    else if (program === 'node') assert.ok(tracked.has(first!), `${command}: ${first} is tracked`);
    else if (program === 'npx') assert.equal(first, publishedPackage(manifest, 'abc', '2026.1.1').name, command);
    else assert.fail(`unknown command in the README: ${command}`);
  }

  // Every inline `mainworks …` command names a command the CLI's help lists.
  const help = execFileSync(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), '--help'], { cwd: root, encoding: 'utf8' });
  const inline = [...readme.matchAll(/`mainworks ([a-z][a-z-]*(?: [a-z][a-z-]*)?)[^`]*`/g)].map(match => match[1]!);
  assert.ok(inline.length >= 5, `inline commands checked: ${inline.length}`);
  for (const command of inline) assert.match(help, new RegExp(`^\\s+${command.split(' ')[0]}\\b`, 'm'), `mainworks ${command} is in the CLI help`);
  for (const command of ['host add', 'master status', 'guide setup']) assert.ok(inline.some(found => found.startsWith(command)), `the README names mainworks ${command}`);
});
