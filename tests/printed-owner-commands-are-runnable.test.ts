import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userLauncherPath } from '../src/install/cli-release.js';
import { resumeCommand } from '../src/install/index.js';
import { hostAddCommand } from '../src/hosts.js';

// GY-3836 AC-1: every line Mainworks prints that begins 'Run this in a terminal:' or tells the
// owner to run a `mainworks` (or legacy `graphyard`) CLI command starts with a command whose first
// word is the launcher installed on PATH.

const proof = 'unit:printed-owner-commands-are-runnable';
const root = fileURLToPath(new URL('..', import.meta.url));
const launcherName = basename(userLauncherPath());

interface CollectedCommand {
  file: string;
  line: number;
  command: string;
  firstWord: string;
}

function walkTs(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkTs(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** Collect printed owner commands from source text: 'Run this in a terminal: ...' and run/rerun CLI instructions. */
function collectOwnerCommands(file: string, source: string): CollectedCommand[] {
  const found: CollectedCommand[] = [];
  const lines = source.split('\n');
  const terminalPattern = /Run this in a terminal:\s*([^\n`'"]+)/g;
  const runCommandPattern = /\b(?:[Rr]erun|[Rr]un)\s+['"`]?((?:mainworks|graphyard)\s+[a-z][a-z0-9-]*(?:\s+[^\n`'"]*)?)/g;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
    for (const pattern of [terminalPattern, runCommandPattern]) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const command = match[1]!.trim();
        const firstWord = command.split(/\s+/)[0]!;
        found.push({ file, line: index + 1, command, firstWord });
      }
    }
  }
  return found;
}

test(`${proof} — every printed 'Run this in a terminal:' or owner CLI command starts with the launcher`, () => {
  assert.equal(launcherName, 'mainworks');
  const collected: CollectedCommand[] = [];
  for (const file of walkTs(join(root, 'src'))) {
    collected.push(...collectOwnerCommands(file.slice(root.length), readFileSync(file, 'utf8')));
  }
  // Also check helper functions that assemble owner-facing commands dynamically.
  const dynamic = [
    { file: 'src/install/index.ts:resumeCommand', line: 0, command: resumeCommand({ inputs: { provider: 'local', repository: 'owner/project', baseBranch: 'main' } as any }) },
    { file: 'src/hosts.ts:hostAddCommand', line: 0, command: hostAddCommand('gy-compute@box', 'owner@box') },
  ].map(entry => ({ ...entry, firstWord: entry.command.trim().split(/\s+/)[0]! }));
  collected.push(...dynamic);

  assert.ok(collected.length >= 10, `expected to collect printed owner commands, got ${collected.length}`);
  assert.ok(collected.some(entry => entry.file.endsWith('src/hosts.ts') && entry.command.startsWith('mainworks host add')), 'collects Run this in a terminal: from src/hosts.ts');

  const bad = collected.filter(entry => entry.firstWord !== launcherName);
  assert.deepEqual(
    bad.map(entry => `${entry.file}:${entry.line}: ${entry.command} (first word: ${entry.firstWord})`),
    [],
    `every printed owner command must start with ${launcherName}`,
  );

  // Sanity check: the collector catches a command whose first word is not the launcher.
  const broken = collectOwnerCommands('synthetic.ts', "throw new Error('Run this in a terminal: graphyard host add vish@box');");
  assert.equal(broken.length, 1);
  assert.notEqual(broken[0]!.firstWord, launcherName);
});
