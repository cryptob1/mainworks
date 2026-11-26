import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const start = readme.split('## Try it\n')[1]?.split('\n## ')[0] ?? '';
const cli = new URL('../src/cli.ts', import.meta.url);
const help = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli.pathname, ...args], { encoding: 'utf8' });

test('unit:readme-onboarding-commands — Try it uses commands and flags advertised by this CLI and omits the unpublished npx line', () => {
  assert.doesNotMatch(start, /\bnpx\b/i, 'Try it omits the unpublished npx line');
  const up = help('up', '--help');
  const all = help('--help');
  const command = start.match(/mainworks\.mjs up ([^\n`]+)/)?.[1];
  assert.ok(command, 'Try it gives an explicit up command');
  assert.match(command, /--repo OWNER\/NAME/);
  for (const flag of start.matchAll(/--[a-z-]+/g)) {
    assert.ok(`${up}\n${all}`.includes(flag[0]), `help advertises ${flag[0]}`);
  }
  assert.ok(start.includes('mainworks doctor'), 'Try it names mainworks doctor');
  assert.match(all, /\bdoctor\b/);
  assert.match(start, /`up` prints a link/);
  assert.match(start, /docs\/setup\.md/);
});
