#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const args = process.argv.slice(2);
let root = fileURLToPath(new URL('../', import.meta.url));
// GY-3214: the published npm package holds no source; it runs the release this host installed.
if (!existsSync(join(root, 'src', 'cli.ts'))) root = await (await import('./bootstrap.mjs')).releaseRoot(root, args);
let child;
// Resolve the complete artifact before loading it. Retained artifacts also keep lazy imports safe.
for (let attempt = 0; ; attempt++) {
  let selected = root;
  try { selected = realpathSync(join(root, '.graphyard', 'cli-current')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // GY-3611: the built CLI while it is as new as the source, else the source through tsx.
  // The check lives in the selected artifact, so a launcher copied alone or an older artifact runs from source.
  const check = join(selected, 'bin', 'built-entry.mjs');
  const built = existsSync(check) && (await import(pathToFileURL(check).href)).builtEntry(selected, 'cli');
  // GY-3627: when NODE_COMPILE_CACHE is already active and no release-handover pointer is in use,
  // load the built CLI directly instead of paying a second Node process start.
  // A release handover (exit code 75) then retries through the spawned path below.
  if (attempt === 0 && built && process.env.NODE_COMPILE_CACHE && selected === root) {
    process.argv[1] = built;
    process.env.GRAPHYARD_LAUNCHER = '1';
    const finished = new Promise(resolve => process.once('beforeExit', resolve));
    await import(pathToFileURL(built).href);
    await finished;
    if (process.exitCode !== 75) break;
    process.exitCode = 0;
    console.error(`[graphyard] release handover: retry 1/3 in 500ms`);
    await new Promise(resolve => setTimeout(resolve, 500));
    continue;
  }
  const entry = built ? [built] : ['--import', createRequire(join(selected, 'package.json')).resolve('tsx'), join(selected, 'src/cli.ts')];
  // Node's compile cache spares the built CLI recompiling its one large file on every start.
  const cache = built ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache') } : {};
  // Forward signals only to a spawned CLI; the in-process path keeps Node's default termination.
  if (!child) for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child = spawn(process.execPath, [...entry, ...args], { stdio: 'inherit', env: { ...process.env, ...cache, GRAPHYARD_LAUNCHER: '1' } });
  const code = await new Promise(resolve => {
    child.on('error', error => { console.error(error.message); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  });
  if (code !== 75 || attempt >= 3) process.exit(code === 75 ? 1 : code);
  console.error(`[graphyard] release handover: retry ${attempt + 1}/3 in 500ms`);
  await new Promise(resolve => setTimeout(resolve, 500));
}
