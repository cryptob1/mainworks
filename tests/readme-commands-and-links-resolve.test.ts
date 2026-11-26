import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GY-3925 (superseding GY-3886): the README is the owner-approved front door — opening with the
// bold promise, true badges only, plain sections, and every fenced command, inline CLI command
// and relative file link resolving on main.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean));
const searchTerms = ['AI coding agents', 'open-source', 'Claude Code', 'Codex', 'Gemini'];

test('unit:readme-commands-and-links-resolve — the README opens with the promise, carries true badges, and every fenced command, inline CLI command and file link resolves', () => {
  const readme = read('README.md');
  const manifest = JSON.parse(read('package.json'));
  const lines = readme.split('\n');
  assert.equal(lines[0], '# Mainworks');
  const promise = lines[2]!.replace(/\*\*/g, '');
  assert.ok(promise.toLowerCase().includes('ai coding agents'), 'the promise says AI coding agents');
  assert.equal(manifest.description, promise, 'package.json description is the promise');

  assert.deepEqual(
    [...readme.matchAll(/^## (.+)$/gm)].map(match => match[1]),
    ['Why this exists', 'What it looks like', 'How it works', 'Try it', 'How fast is it?', 'What to run it on', 'Is it safe to let agents do this?', 'Learn more'],
  );

  const steps = readme.split('\n## How it works\n')[1]!.split('\n## ')[0]!.trim().split('\n').filter(line => /^\d+\. /.test(line)).map(line => line.toLowerCase());
  ['goal', 'build', 'review', 'merge trial', 'deploy', 'watch'].forEach((step, index) => assert.ok(steps[index]?.includes(step), `step ${index + 1} is ${step}`));

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

  const help = execFileSync(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), '--help'], { cwd: root, encoding: 'utf8' });

  // Every fenced command resolves: the clone URL is this repository, npm scripts exist, node runs a tracked file, mainworks names a CLI command.
  const commands = [...readme.matchAll(/```sh\n([^`]+)```/g)].flatMap(match => match[1]!.trim().split('\n')).flatMap(line => line.split(' && '));
  assert.ok(commands.length >= 5, `commands checked: ${commands.length}`);
  for (const command of commands) {
    const [program, first, second] = command.trim().split(/\s+/);
    if (program === 'git' && first === 'clone') assert.equal(second, 'https://github.com/cryptob1/mainworks.git', command);
    else if (program === 'cd') assert.equal(first, manifest.name, command);
    else if (program === 'npm' && first === 'run') assert.ok(manifest.scripts[second!], `${command}: npm script ${second} exists`);
    else if (program === 'npm') assert.equal(first, 'ci', command);
    else if (program === 'node') assert.ok(tracked.has(first!), `${command}: ${first} is tracked`);
    else if (program === 'mainworks') assert.match(help, new RegExp(`^\\s+${first}\\b`, 'm'), `mainworks ${first} is in the CLI help`);
    else assert.fail(`unknown command in the README: ${command}`);
  }

  // Every inline `mainworks …` command names a command the CLI's help lists.
  const inline = [...readme.matchAll(/`mainworks ([a-z][a-z-]*(?: [a-z][a-z-]*)?)[^`]*`/g)].map(match => match[1]!);
  assert.ok(inline.length >= 1, `inline commands checked: ${inline.length}`);
  for (const command of inline) assert.match(help, new RegExp(`^\\s+${command.split(' ')[0]}\\b`, 'm'), `mainworks ${command} is in the CLI help`);
  assert.ok(inline.some(found => found.startsWith('doctor')), 'the README names mainworks doctor');
});
