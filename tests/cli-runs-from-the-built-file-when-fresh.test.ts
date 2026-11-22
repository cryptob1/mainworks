import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtEntry } from '../bin/built-entry.mjs';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-3611: bin/graphyard.mjs runs dist/cli.mjs while it is at least as new as every file under src/,
 * and the sources through tsx otherwise. Proof: unit:cli-runs-from-the-built-file-when-fresh.
 */
const source = fileURLToPath(new URL('..', import.meta.url));

test('unit:cli-runs-from-the-built-file-when-fresh — the launcher runs dist/cli.mjs while it is as new as src/, and the source when it is missing or older', async () => {
  const checkout = await temporaryDirectory('cli-built-file');
  await cp(join(source, 'bin'), join(checkout, 'bin'), { recursive: true });
  await cp(join(source, 'package.json'), join(checkout, 'package.json'));
  await symlink(fileURLToPath(new URL('../..', import.meta.resolve('tsx'))), join(checkout, 'node_modules'));
  await mkdir(join(checkout, 'src', 'nested'), { recursive: true });
  await writeFile(join(checkout, 'src', 'cli.ts'), "const from: string = 'source'; console.log(from, process.argv.slice(2).join(' '));\n");
  await writeFile(join(checkout, 'src', 'nested', 'deep.ts'), 'export {};\n');
  const launch = () => execFileSync(process.execPath, [join(checkout, 'bin', 'graphyard.mjs'), 'a', 'b'], { encoding: 'utf8', cwd: checkout }).trim();
  const at = (seconds: number) => new Date(1_700_000_000_000 + seconds * 1000);

  assert.equal(builtEntry(checkout, 'cli'), null, 'a checkout never built has no built entry');
  assert.equal(launch(), 'source a b', 'a checkout never built runs from source');

  await mkdir(join(checkout, 'dist'));
  const built = join(checkout, 'dist', 'cli.mjs');
  await writeFile(built, "console.log('built', process.argv.slice(2).join(' '));\n");
  await utimes(join(checkout, 'src', 'cli.ts'), at(0), at(0));
  await utimes(join(checkout, 'src', 'nested', 'deep.ts'), at(0), at(0));
  await utimes(built, at(10), at(10));
  assert.equal(builtEntry(checkout, 'cli'), built);
  assert.equal(launch(), 'built a b', 'a fresh build runs, with the same arguments');

  await utimes(join(checkout, 'src', 'nested', 'deep.ts'), at(20), at(20));
  assert.equal(builtEntry(checkout, 'cli'), null, 'a source file newer than the build makes it stale');
  assert.equal(launch(), 'source a b', 'a stale build is passed over for the source');
});

test('unit:cli-runs-from-the-built-file-when-fresh — bin/graphyard.mjs --help from the built file prints the same text as from source', () => {
  assert.ok(builtEntry(source, 'cli'), 'the test runner built dist/cli.mjs before the first file');
  const built = execFileSync(process.execPath, [join(source, 'bin', 'graphyard.mjs'), '--help'], { encoding: 'utf8', cwd: source });
  const fromSource = execFileSync(process.execPath, ['--import', 'tsx', join(source, 'src', 'cli.ts'), '--help'], { encoding: 'utf8', cwd: source });
  assert.match(built, /^Graphyard /);
  assert.equal(built, fromSource);
});
