#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { builtEntry } from './built-entry.mjs';
const args = process.argv.slice(2);
let root = fileURLToPath(new URL('../', import.meta.url));
// GY-3214: the published npm package holds no source; it runs the release this host installed.
if (!existsSync(join(root, 'src', 'cli.ts'))) root = await (await import('./bootstrap.mjs')).releaseRoot(root, args);
let child;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child?.kill(signal));
// Resolve the complete artifact before loading it. Retained artifacts also keep lazy imports safe.
for (let attempt = 0; ; attempt++) {
  let selected = root;
  try { selected = realpathSync(join(root, '.graphyard', 'cli-current')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // GY-3611: the built CLI while it is as new as the source, else the source through tsx.
  const built = builtEntry(selected, 'cli');
  const entry = built ? [built] : ['--import', createRequire(join(selected, 'package.json')).resolve('tsx'), join(selected, 'src/cli.ts')];
  child = spawn(process.execPath, [...entry, ...args], { stdio: 'inherit', env: { ...process.env, GRAPHYARD_LAUNCHER: '1' } });
  const code = await new Promise(resolve => {
    child.on('error', error => { console.error(error.message); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  });
  if (code !== 75 || attempt >= 3) process.exit(code === 75 ? 1 : code);
  console.error(`[graphyard] release handover: retry ${attempt + 1}/3 in 500ms`);
  await new Promise(resolve => setTimeout(resolve, 500));
}
