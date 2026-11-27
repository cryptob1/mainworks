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
// GY-4003: a release handover (exit code 75: the server serves another commit, as it does mid-deploy)
// retries with backoff for up to a minute, reloading the CLI pointer each time, then gives up.
// A CLI that ran a while before handing over (a watch following a deploy) starts a fresh window.
const handoverMs = Number(process.env.MAINWORKS_RELEASE_HANDOVER_MS ?? process.env.GRAPHYARD_RELEASE_HANDOVER_MS ?? 60_000);
let windowStart = 0, retries = 0;
const retryHandover = async startedAt => {
  if (Date.now() - startedAt > 15_000 || !windowStart) { windowStart = Date.now(); retries = 0; }
  const remaining = windowStart + handoverMs - Date.now();
  if (remaining <= 0) { console.error(`[mainworks] release handover: the server still serves another commit after ${Math.round(handoverMs / 1000)}s; giving up`); return false; }
  const ms = Math.min(500 * 2 ** retries++, 5_000, remaining);
  console.error(`[mainworks] release handover: retry ${retries} in ${ms}ms`);
  await new Promise(resolve => setTimeout(resolve, ms));
  return true;
};
// Resolve the complete artifact before loading it. Retained artifacts also keep lazy imports safe.
for (let attempt = 0; ; attempt++) {
  const startedAt = Date.now();
  let selected = root;
  // GY-3711: a fresh install keeps its state in .mainworks; an existing one in .graphyard.
  try { selected = realpathSync(join(root, existsSync(join(root, '.mainworks')) ? '.mainworks' : '.graphyard', 'cli-current')); }
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
    process.env.GRAPHYARD_LAUNCHER = process.env.MAINWORKS_LAUNCHER = '1';
    const finished = new Promise(resolve => process.once('beforeExit', resolve));
    await import(pathToFileURL(built).href);
    await finished;
    if (process.exitCode !== 75) break;
    if (!await retryHandover(startedAt)) { process.exitCode = 1; break; }
    process.exitCode = 0;
    continue;
  }
  const entry = built ? [built] : ['--import', createRequire(join(selected, 'package.json')).resolve('tsx'), join(selected, 'src/cli.ts')];
  // Node's compile cache spares the built CLI recompiling its one large file on every start.
  const cache = built ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? join(tmpdir(), 'node-compile-cache') } : {};
  // Forward signals only to a spawned CLI; the in-process path keeps Node's default termination.
  if (!child) for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child = spawn(process.execPath, [...entry, ...args], { stdio: 'inherit', env: { ...process.env, ...cache, GRAPHYARD_LAUNCHER: '1', MAINWORKS_LAUNCHER: '1' } });
  const code = await new Promise(resolve => {
    child.on('error', error => { console.error(error.message); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  });
  if (code !== 75) process.exit(code);
  if (!await retryHandover(startedAt)) process.exit(1);
}
